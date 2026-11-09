import { hostname } from "node:os";
import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().url(),
  SECRETS_PRIVATE_KEY: z.string().min(40),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  WORKER_INSTANCE_ID: z.string().default(hostname()),
  METAAPI_REQUEST_TIMEOUT_S: z.coerce.number().int().positive().default(60),
  SYNC_INTERVAL_S: z.coerce.number().int().min(10).default(30),
  RUN_MIGRATIONS: z.enum(["true", "false"]).default("true"),
  MIGRATIONS_DIR: z.string().optional(),
  APP_VERSION: z.string().default("dev"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid worker configuration: ${issues}`);
  }
  return parsed.data;
}
