import { Cron } from "croner";
import type { Ctx } from "./context.js";
import type { MetaApiManager } from "./metaapi/manager.js";
import { runAgent } from "./agent/runner.js";
import { generateBrief } from "./analyst/brief.js";
import { drainCommands } from "./commands.js";
import { systemEvent } from "./events.js";
import { computeEventReactions, dueEventTriggers, sampleEventWindows } from "./market/events-watch.js";
import { buildReport } from "./reports/daily.js";
import { getSetting } from "./settings.js";
import { runSource } from "./sources/index.js";
import { notify } from "./telegram.js";
import { heartbeat, syncAll } from "./trading/sync.js";

/** True when a 5-field cron expression fires at the given minute (UTC). */
export function firesAt(expr: string, minute: Date): boolean {
  try {
    const c = new Cron(expr, { paused: true, timezone: "UTC" });
    const next = c.nextRun(new Date(minute.getTime() - 1000));
    c.stop();
    return !!next && next.getTime() === minute.getTime();
  } catch {
    return false;
  }
}

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Runs `fn` every `ms`, never overlapping with itself; errors are logged, not fatal. */
function every(ctx: Ctx, name: string, ms: number, fn: () => Promise<void>, runNow = true): () => void {
  let running = false;
  const tick = async () => {
    if (running || ctx.stopping.value) return;
    running = true;
    try { await fn(); } catch (err) { ctx.log.error({ err, job: name }, "job failed"); } finally { running = false; }
  };
  const handle = setInterval(tick, ms);
  if (runNow) void tick();
  return () => clearInterval(handle);
}

export function startScheduler(ctx: Ctx, mt: MetaApiManager): () => void {
  const agentSlots = new Semaphore(4);
  const inFlight = new Set<string>();
  const fired = new Set<string>();

  const launchAgent = (agentId: string, trigger: "schedule" | "event", ref: string | null) => {
    if (inFlight.has(agentId)) return;
    inFlight.add(agentId);
    void agentSlots.run(() => runAgent(ctx, mt, agentId, trigger, ref))
      .catch((err) => ctx.log.error({ err, agentId }, "agent run crashed"))
      .finally(() => inFlight.delete(agentId));
  };

  const stops: (() => void)[] = [];

  stops.push(every(ctx, "sync", ctx.config.SYNC_INTERVAL_S * 1000, () => syncAll(ctx, mt)));
  stops.push(every(ctx, "heartbeat", 60_000, () => heartbeat(ctx, mt)));
  stops.push(every(ctx, "worker-heartbeat", 30_000, async () => {
    await ctx.sql`
      insert into worker_heartbeats (instance_id, started_at, version, info, beat_at)
      values (${ctx.config.WORKER_INSTANCE_ID}, ${startedAt}, ${ctx.config.APP_VERSION},
              ${ctx.sql.json({ agents_in_flight: inFlight.size, metaapi_configured: await mt.configured() } as never)}, now())
      on conflict (instance_id) do update set beat_at = now(), version = excluded.version, info = excluded.info`;
  }));
  stops.push(every(ctx, "commands-poll", 5_000, () => drainCommands(ctx, mt)));
  stops.push(every(ctx, "event-windows", 60_000, async () => { if (await mt.configured()) await sampleEventWindows(ctx, mt); }, false));
  stops.push(every(ctx, "event-reactions", 5 * 60_000, async () => { if (await mt.configured()) await computeEventReactions(ctx, mt); }, false));

  // Minute ticker: cron-scheduled agents, event triggers, analyst, daily report, sources, retention.
  stops.push(every(ctx, "minute", 15_000, async () => {
    const now = new Date();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const key = (k: string) => `${k}@${minute.getTime()}`;
    const once = (k: string) => { if (fired.has(key(k))) return false; fired.add(key(k)); return true; };
    if (fired.size > 5000) fired.clear();

    // Agents run even with trading switched off: the runner then only manages open positions.
    const agents = await ctx.sql<{ id: string; schedule_cron: string }[]>`select id, schedule_cron from agents where status = 'active'`;
    for (const a of agents) if (firesAt(a.schedule_cron, minute) && once(`agent:${a.id}`)) launchAgent(a.id, "schedule", null);
    for (const t of await dueEventTriggers(ctx)) if (once(`event:${t.agentId}:${t.eventId}`)) launchAgent(t.agentId, "event", t.eventId);

    const analyst = await getSetting(ctx, "analyst");
    if (analyst.model_id && firesAt(analyst.cron, minute) && once("analyst")) {
      generateBrief(ctx).catch((err) => systemEvent(ctx, "error", "analyst", "brief_failed", (err as Error).message));
    }
    const daily = await getSetting(ctx, "daily_report");
    if (firesAt(daily.cron, minute) && once("daily")) {
      buildReport(ctx, "daily").then((r) => notify(ctx, r)).catch((err) => ctx.log.error({ err }, "daily report failed"));
    }
    if (firesAt("7 */6 * * *", minute) && once("ff")) runSource(ctx, "forexfactory").catch((err) => ctx.log.warn({ err }, "forexfactory failed"));
    if (firesAt("20 2 * * 6", minute) && once("cot")) runSource(ctx, "cftc_cot").catch((err) => ctx.log.warn({ err }, "cftc failed"));
    if (firesAt("40 3 * * *", minute) && once("retention")) await retention(ctx);
  }));

  // Initial data if missing/stale.
  void (async () => {
    const stale = await ctx.sql<{ code: string }[]>`select code from v_data_source_health where code in ('forexfactory','cftc_cot') and health in ('never','stale')`;
    for (const s of stale) await runSource(ctx, s.code).catch((err) => ctx.log.warn({ err, source: s.code }, "initial fetch failed"));
  })();

  return () => stops.forEach((s) => s());
}

const startedAt = new Date();

async function retention(ctx: Ctx): Promise<void> {
  const r = await getSetting(ctx, "retention_days");
  await ctx.sql`delete from connection_heartbeats where checked_at < now() - make_interval(days => ${r.heartbeats})`;
  await ctx.sql`delete from spread_samples where sampled_at < now() - make_interval(days => ${r.spread_samples}) and context = 'periodic'`;
  await ctx.sql`update llm_calls set request = null, response = null where started_at < now() - make_interval(days => ${r.llm_payloads}) and request is not null`;
  await ctx.sql`delete from commands where finished_at < now() - interval '30 days'`;
  await ctx.sql`delete from login_attempts where attempted_at < now() - interval '30 days'`;
  await ctx.sql`delete from worker_heartbeats where beat_at < now() - interval '7 days'`;
}
