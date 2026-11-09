export interface CriteriaInput {
  min_period_days: number;
  min_trades: number;
  min_expectancy_r: number;
  max_drawdown_pct: number;
  min_profit_factor: number;
  max_brier: number | null;
}

export interface StatsInput {
  closed_trades: number;
  expectancy_r: number | null;
  max_drawdown_pct: number;
  profit_factor: number | null;
  brier: number | null;
  first_trade_at: Date | null;
}

export type CheckState = "pass" | "fail" | "pending";

export interface CriterionCheck {
  key: string;
  label: string;
  state: CheckState;
  actual: string;
  required: string;
}

export interface CriteriaVerdict {
  verdict: "in_progress" | "passed" | "failed";
  checks: CriterionCheck[];
}

/**
 * Compares an agent's results with the strategy's pre-registered criteria.
 * Sample-size checks gate the verdict: until the period and trade count are met,
 * the verdict stays "in_progress" — except drawdown, which can fail early.
 */
export function evaluateCriteria(c: CriteriaInput, s: StatsInput, now: Date): CriteriaVerdict {
  const days = s.first_trade_at ? (now.getTime() - s.first_trade_at.getTime()) / 86_400_000 : 0;
  const fmt = (n: number | null, d = 2) => (n === null || Number.isNaN(n) ? "—" : n.toFixed(d));
  const sampleDone = days >= c.min_period_days && s.closed_trades >= c.min_trades;

  const checks: CriterionCheck[] = [
    { key: "period", label: "Okres testu", state: days >= c.min_period_days ? "pass" : "pending",
      actual: `${Math.floor(days)} dni`, required: `≥ ${c.min_period_days} dni` },
    { key: "trades", label: "Liczba transakcji", state: s.closed_trades >= c.min_trades ? "pass" : "pending",
      actual: String(s.closed_trades), required: `≥ ${c.min_trades}` },
    { key: "expectancy", label: "Wartość oczekiwana (R)",
      state: !sampleDone ? "pending" : (s.expectancy_r ?? -Infinity) > c.min_expectancy_r ? "pass" : "fail",
      actual: fmt(s.expectancy_r, 3), required: `> ${c.min_expectancy_r}` },
    { key: "drawdown", label: "Maks. obsunięcie",
      state: s.max_drawdown_pct > c.max_drawdown_pct ? "fail" : sampleDone ? "pass" : "pending",
      actual: `${fmt(s.max_drawdown_pct)}%`, required: `≤ ${c.max_drawdown_pct}%` },
    { key: "profit_factor", label: "Profit factor",
      state: !sampleDone ? "pending" : (s.profit_factor ?? 0) >= c.min_profit_factor ? "pass" : "fail",
      actual: fmt(s.profit_factor), required: `≥ ${c.min_profit_factor}` },
  ];
  if (c.max_brier !== null) {
    checks.push({ key: "brier", label: "Kalibracja (Brier)",
      state: !sampleDone ? "pending" : s.brier !== null && s.brier <= c.max_brier ? "pass" : "fail",
      actual: fmt(s.brier, 3), required: `≤ ${c.max_brier}` });
  }

  const anyFail = checks.some((x) => x.state === "fail");
  const allPass = checks.every((x) => x.state === "pass");
  return { verdict: anyFail ? "failed" : allPass ? "passed" : "in_progress", checks };
}
