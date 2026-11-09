import "server-only";
import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  SECRETS_PUBLIC_KEY: z.string().min(40),
  SESSION_SECRET: z.string().min(32),
  DASHBOARD_PASSWORD_HASH: z.string().regex(/^scrypt:\d+:\d+:\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/, "use scripts/hash-password.mjs"),
  PUBLIC_URL: z.string().url().default("https://trading.v5v.pl"),
});

let cached: z.infer<typeof Env> | null = null;

export function env(): z.infer<typeof Env> {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`invalid web configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  cached = parsed.data;
  return cached;
}
