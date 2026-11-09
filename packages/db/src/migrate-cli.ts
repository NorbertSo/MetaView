import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";
import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (bundled): migrations sit next to the package root.
const dir = process.env.MIGRATIONS_DIR ?? path.resolve(here, "..", "migrations");

const sql = createDb({ url, max: 1, applicationName: "tv-migrate" });
try {
  const res = await migrate(sql, dir);
  console.log(`migrations: ${res.applied.length} applied, ${res.skipped.length} already present`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
