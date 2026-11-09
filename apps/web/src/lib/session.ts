import { jwtVerify, SignJWT } from "jose";

/** Edge-compatible session helpers (used by middleware and server code). */
export const SESSION_COOKIE = "tv_session";
export const SESSION_TTL_S = 7 * 24 * 3600;

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(secret: string): Promise<string> {
  return new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_S}s`)
    .setIssuer("trading-v5v")
    .sign(key(secret));
}

export async function verifySession(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: "trading-v5v", algorithms: ["HS256"] });
    return payload.sub === "owner";
  } catch {
    return false;
  }
}
