import { evaluateCriteria } from "@tv/core";
import type { Ctx } from "../context.js";
import { escapeHtml } from "../events.js";

/** Builds the master report (agents, criteria, health, overrides). Used for the daily Telegram report and /status. */
export async function buildReport(ctx: Ctx, kind: "daily" | "status"): Promise<string> {
  const agents = await ctx.sql<{
    id: string; code: string; name: string; status: string; strategy_id: string; model: string; allocated_capital: number;
    equity: number; open_positions: number; closed_trades: number; expectancy_r: number | null; profit_factor: number | null;
    max_drawdown_pct: number; brier: number | null; first_trade_at: Date | null; llm_cost_usd: number;
  }[]>`
    select a.id, a.code, a.name, a.status, v.strategy_id, m.display_name as model, a.allocated_capital,
           s.equity, s.open_positions, s.closed_trades, s.expectancy_r, s.profit_factor, s.max_drawdown_pct, s.brier,
           s.first_trade_at, s.llm_cost_usd
    from agents a join v_agent_stats s on s.agent_id = a.id
    join strategy_versions v on v.id = a.strategy_version_id join llm_models m on m.id = a.model_id
    where a.status in ('active','paused','killed') order by a.code`;
  const today = await ctx.sql<{ agent_id: string; trades: number; net_pnl: number; total_r: number }[]>`
    select agent_id, trades, net_pnl, total_r from v_daily_agent_pnl where day = (now() at time zone 'UTC')::date`;
  const todayBy = new Map(today.map((t) => [t.agent_id, t]));
  const criteria = await ctx.sql<{ strategy_id: string; min_period_days: number; min_trades: number; min_expectancy_r: number; max_drawdown_pct: number; min_profit_factor: number; max_brier: number | null }[]>`
    select strategy_id, min_period_days, min_trades, min_expectancy_r, max_drawdown_pct, min_profit_factor, max_brier from v_current_criteria`;
  const critBy = new Map(criteria.map((c) => [c.strategy_id, c]));

  const lines: string[] = [kind === "daily" ? "📊 <b>Raport dzienny</b>" : "📍 <b>Status</b>"];
  const [trading] = await ctx.sql<{ value: boolean }[]>`select value from app_settings where key = 'trading_enabled'`;
  lines.push(`Handel: ${trading?.value ? "włączony" : "WYŁĄCZONY"}`);
  if (!agents.length) lines.push("Brak agentów.");
  for (const a of agents) {
    const t = todayBy.get(a.id);
    const pnlPct = ((a.equity - a.allocated_capital) / a.allocated_capital) * 100;
    let verdict = "brak kryteriów";
    const c = critBy.get(a.strategy_id);
    if (c) {
      const v = evaluateCriteria(c, { closed_trades: a.closed_trades, expectancy_r: a.expectancy_r, max_drawdown_pct: a.max_drawdown_pct,
        profit_factor: a.profit_factor, brier: a.brier, first_trade_at: a.first_trade_at }, new Date());
      verdict = v.verdict === "passed" ? "✅ spełnia" : v.verdict === "failed" ? "❌ nie spełnia" : "⏳ w trakcie";
    }
    lines.push(
      `\n<b>${escapeHtml(a.code)}</b> ${escapeHtml(a.name)} · ${escapeHtml(a.model)} · ${a.status}\n` +
      `Equity ${a.equity.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%), DD max ${a.max_drawdown_pct.toFixed(2)}%, poz. ${a.open_positions}\n` +
      `Dziś: ${t ? `${t.trades} tr., ${t.net_pnl.toFixed(2)} (${t.total_r.toFixed(2)}R)` : "bez zamkniętych"} · ` +
      `Razem ${a.closed_trades} tr., E=${a.expectancy_r?.toFixed(3) ?? "—"}R, PF ${a.profit_factor?.toFixed(2) ?? "—"} · AI $${a.llm_cost_usd.toFixed(2)}\n` +
      `Kryteria: ${verdict}`);
  }
  const health = await ctx.sql<{ name: string; health: string }[]>`select name, health from v_data_source_health where health in ('stale','error')`;
  if (health.length) lines.push(`\n⚠️ Źródła danych: ${health.map((h) => `${escapeHtml(h.name)} (${h.health})`).join(", ")}`);
  const issues = await ctx.sql<{ n: number }[]>`select count(*)::int as n from reconciliation_issues where resolved_at is null`;
  if (issues[0]?.n) lines.push(`⚠️ Nierozwiązane rozbieżności z brokerem: ${issues[0].n}`);
  if (kind === "daily") {
    const ov = await ctx.sql<{ n: number }[]>`select count(*)::int as n from manual_overrides where created_at > now() - interval '24 hours'`;
    lines.push(`\nTwoje interwencje (24h): ${ov[0]?.n ?? 0}`);
  }
  return lines.join("\n");
}
