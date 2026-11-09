import "server-only";
import { evaluateCriteria, type CriteriaVerdict } from "@tv/core";
import { db } from "./db";

export interface AgentSummary {
  id: string; code: string; name: string; status: string; status_reason: string | null; model: string; provider: string;
  strategy_id: string; strategy_code: string; strategy_name: string; version: number; account_name: string; currency: string | null;
  allocated_capital: number; equity: number; realized_pnl: number; unrealized_pnl: number; open_positions: number;
  closed_trades: number; win_rate: number | null; expectancy_r: number | null; profit_factor: number | null;
  max_drawdown_pct: number; brier: number | null; first_trade_at: Date | null; llm_cost_usd: number; llm_calls: number;
  schedule_cron: string; risk_per_trade_pct: number; magic: number; instruments: string[]; created_at: Date; activated_at: Date | null;
}

export async function agentSummaries(where: { id?: string } = {}): Promise<AgentSummary[]> {
  const sql = db();
  return sql<AgentSummary[]>`
    select a.id, a.code, a.name, a.status, a.status_reason, m.display_name as model, p.name as provider,
           s.id as strategy_id, s.code as strategy_code, s.name as strategy_name, v.version, acc.name as account_name, acc.currency,
           a.allocated_capital, st.equity, st.realized_pnl, st.unrealized_pnl, st.open_positions, st.closed_trades, st.win_rate,
           st.expectancy_r, st.profit_factor, st.max_drawdown_pct, st.brier, st.first_trade_at, st.llm_cost_usd, st.llm_calls,
           a.schedule_cron, a.risk_per_trade_pct, a.magic, a.instruments, a.created_at, a.activated_at
    from agents a
    join v_agent_stats st on st.agent_id = a.id
    join llm_models m on m.id = a.model_id join llm_providers p on p.id = m.provider_id
    join strategy_versions v on v.id = a.strategy_version_id join strategies s on s.id = v.strategy_id
    join mt_accounts acc on acc.id = a.mt_account_id
    where (${where.id ?? null}::uuid is null or a.id = ${where.id ?? null}::uuid)
    order by case a.status when 'active' then 0 when 'paused' then 1 when 'draft' then 2 when 'killed' then 3 else 4 end, a.code`;
}

export async function criteriaByStrategy(): Promise<Map<string, { min_period_days: number; min_trades: number; min_expectancy_r: number; max_drawdown_pct: number; min_profit_factor: number; max_brier: number | null }>> {
  const rows = await db()<{ strategy_id: string; min_period_days: number; min_trades: number; min_expectancy_r: number; max_drawdown_pct: number; min_profit_factor: number; max_brier: number | null }[]>`
    select strategy_id, min_period_days, min_trades, min_expectancy_r, max_drawdown_pct, min_profit_factor, max_brier from v_current_criteria`;
  return new Map(rows.map((r) => [r.strategy_id, r]));
}

export function verdictFor(a: AgentSummary, crit: Awaited<ReturnType<typeof criteriaByStrategy>>): CriteriaVerdict | null {
  const c = crit.get(a.strategy_id);
  if (!c) return null;
  return evaluateCriteria(c, {
    closed_trades: a.closed_trades, expectancy_r: a.expectancy_r, max_drawdown_pct: a.max_drawdown_pct,
    profit_factor: a.profit_factor, brier: a.brier, first_trade_at: a.first_trade_at,
  }, new Date());
}

export async function getSettingValue<T>(key: string): Promise<T> {
  const [row] = await db()<{ value: T }[]>`select value from app_settings where key = ${key}`;
  if (!row) throw new Error(`setting ${key} missing`);
  return row.value;
}
