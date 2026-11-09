import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.redirect(new URL("/login", env().PUBLIC_URL), 303);
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
