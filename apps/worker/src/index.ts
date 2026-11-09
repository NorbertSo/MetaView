import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { privateKeyFromBase64 } from "@tv/core/crypto";
import { createDb, migrate } from "@tv/db";
import { loadConfig } from "./config.js";
import type { Ctx } from "./context.js";
import { drainCommands, recoverStuckCommands } from "./commands.js";
import { MetaApiManager } from "./metaapi/manager.js";
import { buildReport } from "./reports/daily.js";
import { startScheduler } from "./scheduler.js";
import { pollTelegram } from "./telegram.js";
import { systemEvent } from "./events.js";

async function main() {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL, base: { svc: "worker", instance: config.WORKER_INSTANCE_ID } });
  const sql = createDb({ url: config.DATABASE_URL, max: 12, applicationName: "tv-worker" });
  const ctx: Ctx = { sql, log, config, privateKey: privateKeyFromBase64(config.SECRETS_PRIVATE_KEY), stopping: { value: false } };

  if (config.RUN_MIGRATIONS === "true") {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = config.MIGRATIONS_DIR ?? path.resolve(here, "../../../packages/db/migrations");
    const res = await migrate(sql, dir, (m) => log.info(m));
    log.info({ applied: res.applied.length }, "migrations checked");
  }

  await recoverStuckCommands(ctx);
  const mt = new MetaApiManager(ctx);
  const stopScheduler = startScheduler(ctx, mt);

  // React to new commands immediately (polling remains as a fallback).
  let draining = false;
  const drain = () => {
    if (draining) return;
    draining = true;
    drainCommands(ctx, mt).catch((err) => log.error({ err }, "command drain failed")).finally(() => { draining = false; });
  };
  const listener = await sql.listen("trading_commands", drain).catch((err) => {
    log.warn({ err }, "LISTEN unavailable; relying on polling");
    return null;
  });

  void pollTelegram(ctx, () => buildReport(ctx, "status"));
  await systemEvent(ctx, "info", "worker", "started", `Worker ${config.WORKER_INSTANCE_ID} (${config.APP_VERSION}) uruchomiony`, { telegram: false });
  log.info("worker started");

  const shutdown = async (signal: string) => {
    if (ctx.stopping.value) return;
    ctx.stopping.value = true;
    log.info({ signal }, "shutting down");
    stopScheduler();
    await listener?.unlisten().catch(() => undefined);
    mt.closeAll();
    // Give in-flight runs a moment to persist their state.
    await new Promise((r) => setTimeout(r, 5_000));
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
