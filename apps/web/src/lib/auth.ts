import "server-only";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "./env";
import { SESSION_COOKIE, verifySession } from "./session";

/**
 * Hash format: scrypt:N:r:p:saltB64:hashB64 (generate with `node scripts/hash-password.mjs`).
 * ':' is used instead of '$' so the value survives .env / docker-compose interpolation.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Defense in depth: every server action and page re-checks the session (middleware is the first gate). */
export async function requireSession(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySession(token, env().SESSION_SECRET))) redirect("/login");
}
