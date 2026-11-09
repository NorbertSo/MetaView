import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * Sealed-box encryption (ECIES): X25519 + HKDF-SHA256 + AES-256-GCM.
 *
 * The dashboard holds only the public key and can encrypt secrets it receives
 * (API keys, broker passwords); it can never read them back. Only the worker,
 * holding the private key, can decrypt.
 *
 * Format (base64url): "v1." + ephemeralPub(32) | iv(12) | tag(16) | ciphertext
 */

const VERSION = "v1";
const INFO = Buffer.from("trading-v5v sealed secret v1");

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("invalid X25519 public key");
  return Buffer.from(jwk.x, "base64url");
}

export function publicKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64url");
  if (raw.length !== 32) throw new Error("SECRETS_PUBLIC_KEY must be a 32-byte X25519 key (base64url)");
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

export function privateKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64url");
  if (raw.length !== 32) throw new Error("SECRETS_PRIVATE_KEY must be a 32-byte X25519 key (base64url)");
  // PKCS#8 DER wrapper for a raw X25519 private key (RFC 8410).
  const der = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), raw]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  return { publicKey: jwk.x, privateKey: jwk.d };
}

function deriveKey(shared: Buffer, ephPub: Buffer, recipientPub: Buffer): Buffer {
  const salt = Buffer.concat([ephPub, recipientPub]);
  return Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
}

export function seal(plaintext: string, recipientPublicKey: KeyObject): string {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPublicKey });
  const ephPub = rawPublic(eph.publicKey);
  const key = deriveKey(shared, ephPub, rawPublic(recipientPublicKey));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ephPub);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([ephPub, iv, tag, ct]).toString("base64url")}`;
}

export function open(sealed: string, recipientPrivateKey: KeyObject): string {
  const [version, body] = sealed.split(".");
  if (version !== VERSION || !body) throw new Error("unsupported secret format");
  const buf = Buffer.from(body, "base64url");
  if (buf.length < 32 + 12 + 16) throw new Error("secret too short");
  const ephPub = buf.subarray(0, 32);
  const iv = buf.subarray(32, 44);
  const tag = buf.subarray(44, 60);
  const ct = buf.subarray(60);
  const ephKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: ephPub.toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephKey });
  const recipientPub = rawPublic(createPublicKey(recipientPrivateKey));
  const key = deriveKey(shared, ephPub, recipientPub);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(ephPub);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function last4(secret: string): string {
  const s = secret.trim();
  return s.length <= 4 ? "****" : s.slice(-4);
}
