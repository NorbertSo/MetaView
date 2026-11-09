import { NextResponse, type NextRequest } from "next/server";
import { verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { SESSION_COOKIE, SESSION_TTL_S, signSession } from "@/lib/session";

export const runtime = "nodejs";

const WINDOW_MIN = 15;
const MAX_FAILURES = 5;

function clientIp(req: NextRequest): string {
  // Coolify's Traefik (behind Cloudflare) sets these; take the first hop.
  return (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim();
}

export async function POST(req: NextRequest) {
  const sql = db();
  const ip = clientIp(req);
  const form = await req.formData();
  const password = String(form.get("password") ?? "");

  const [recent] = await sql<{ n: number }[]>`
    select count(*)::int as n from login_attempts
    where ip = ${ip} and not success and attempted_at > now() - make_interval(mins => ${WINDOW_MIN})`;
  const redirectTo = (q: string) => NextResponse.redirect(new URL(`/login${q}`, env().PUBLIC_URL), 303);
  if ((recent?.n ?? 0) >= MAX_FAILURES) return redirectTo("?error=locked");

  const ok = password.length > 0 && password.length < 512 && verifyPassword(password, env().DASHBOARD_PASSWORD_HASH);
  await sql`insert into login_attempts (ip, success) values (${ip}, ${ok})`;
  if (!ok) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return redirectTo("?error=invalid");
  }
  const res = NextResponse.redirect(new URL("/", env().PUBLIC_URL), 303);
  res.cookies.set(SESSION_COOKIE, await signSession(env().SESSION_SECRET), {
    httpOnly: true, secure: env().PUBLIC_URL.startsWith("https://"), sameSite: "lax", path: "/", maxAge: SESSION_TTL_S,
  });
  return res;
}
