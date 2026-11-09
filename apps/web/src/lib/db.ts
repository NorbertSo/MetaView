import "server-only";
import { createDb, type Sql } from "@tv/db";
import { env } from "./env";

const g = globalThis as unknown as { __tvSql?: Sql };

/** Single pooled client per server process (survives dev hot reloads). */
export function db(): Sql {
  if (!g.__tvSql) g.__tvSql = createDb({ url: env().DATABASE_URL, max: 8, applicationName: "tv-web" });
  return g.__tvSql;
}
