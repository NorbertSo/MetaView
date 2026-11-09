import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "./client.js";

const LOCK_KEY = 7_141_592_653; // pg_advisory_lock key for migrations

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies SQL migrations in lexical order. Each file runs in its own
 * transaction; a checksum guards against editing an already-applied file.
 * A session-level advisory lock makes concurrent starts safe.
 */
export async function migrate(sql: Sql, dir: string, log: (m: string) => void = console.log): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };

  await sql.reserve().then(async (conn) => {
    try {
      await conn`select pg_advisory_lock(${LOCK_KEY})`;
      await conn`create schema if not exists trading`;
      await conn`
        create table if not exists trading.schema_migrations (
          name        text primary key,
          checksum    text not null,
          applied_at  timestamptz not null default now()
        )`;
      const rows = await conn<{ name: string; checksum: string }[]>`select name, checksum from trading.schema_migrations`;
      const done = new Map(rows.map((r) => [r.name, r.checksum]));

      for (const file of files) {
        const body = await readFile(path.join(dir, file), "utf8");
        const checksum = createHash("sha256").update(body).digest("hex");
        const prev = done.get(file);
        if (prev) {
          if (prev !== checksum) {
            throw new Error(`migration ${file} was modified after being applied (checksum mismatch)`);
          }
          result.skipped.push(file);
          continue;
        }
        log(`applying ${file}`);
        await conn.unsafe("begin");
        try {
          await conn.unsafe(body);
          await conn`insert into trading.schema_migrations (name, checksum) values (${file}, ${checksum})`;
          await conn.unsafe("commit");
        } catch (err) {
          await conn.unsafe("rollback");
          throw new Error(`migration ${file} failed: ${(err as Error).message}`);
        }
        result.applied.push(file);
      }

      // Defense in depth: every table in `trading` has RLS on (no policies =
      // no access for Data API roles). The owner role used by the apps bypasses RLS.
      await conn.unsafe(`
        do $$ declare r record; begin
          for r in select tablename from pg_tables where schemaname = 'trading' loop
            execute format('alter table trading.%I enable row level security', r.tablename);
          end loop;
        end $$;`);
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined);
      conn.release();
    }
  });

  return result;
}
