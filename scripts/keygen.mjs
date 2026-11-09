// Generates the X25519 key pair used for sealed secrets.
// SECRETS_PUBLIC_KEY goes to the web app, SECRETS_PRIVATE_KEY only to the worker.
import { generateKeyPairSync } from "node:crypto";
const { privateKey } = generateKeyPairSync("x25519");
const jwk = privateKey.export({ format: "jwk" });
console.log(`SECRETS_PUBLIC_KEY=${jwk.x}`);
console.log(`SECRETS_PRIVATE_KEY=${jwk.d}`);
