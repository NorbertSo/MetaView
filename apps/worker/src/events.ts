import type { Ctx } from "./context.js";
import { notify } from "./telegram.js";
import { getSetting } from "./settings.js";

export type Level = "debug" | "info" | "warn" | "error" | "critical";
const rank: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 };

export interface EventOpts {
  agentId?: string | null;
  mtAccountId?: string | null;
  context?: Record<string, unknown>;
  /** Force (or suppress) a Telegram notification regardless of the configured level. */
  telegram?: boolean;
}

/** Writes a system event, logs it, and notifies Telegram when at/above the configured level. */
export async function systemEvent(ctx: Ctx, level: Level, source: string, kind: string, message: string, opts: EventOpts = {}): Promise<void> {
  const logFn = level === "critical" ? "fatal" : level;
  ctx.log[logFn === "fatal" ? "error" : logFn]({ source, kind, ...opts.context }, message);
  try {
    await ctx.sql`
      insert into system_events (level, source, kind, message, agent_id, mt_account_id, context)
      values (${level}, ${source}, ${kind}, ${message}, ${opts.agentId ?? null}, ${opts.mtAccountId ?? null},
              ${ctx.sql.json((opts.context ?? {}) as never)})`;
  } catch (err) {
    ctx.log.error({ err }, "failed to persist system event");
  }
  try {
    const tg = await getSetting(ctx, "telegram");
    const should = opts.telegram ?? rank[level] >= rank[tg.notify_level];
    if (should) {
      const icon = level === "critical" ? "🛑" : level === "error" ? "❗" : level === "warn" ? "⚠️" : "ℹ️";
      await notify(ctx, `${icon} <b>${escapeHtml(kind)}</b>\n${escapeHtml(message)}`);
    }
  } catch (err) {
    ctx.log.warn({ err }, "telegram notification skipped");
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
