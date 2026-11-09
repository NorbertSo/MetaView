// Usage: node scripts/hash-password.mjs 'your password'
// Prints the DASHBOARD_PASSWORD_HASH value (scrypt, N=2^15, r=8, p=1).
import { randomBytes, scryptSync } from "node:crypto";
const pw = process.argv[2];
if (!pw || pw.length < 10) { console.error("password must be at least 10 characters"); process.exit(1); }
const N = 32768, r = 8, p = 1, salt = randomBytes(16);
const hash = scryptSync(pw, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`);
