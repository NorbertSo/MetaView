/** Sums and counts as returned by v_instrument_stats / v_instrument_agent_stats. */
export interface InstrumentAgg {
  trades_total: number;
  open_trades: number;
  closed_trades: number;
  wins: number;
  losses: number;
  long_closed: number;
  long_wins: number;
  short_closed: number;
  short_wins: number;
  net_pnl: number;
  gross_profit: number;
  gross_loss: number;
  costs: number;
  open_pnl: number;
  r_count: number;
  total_r: number;
  best_r: number | null;
  worst_r: number | null;
  hold_hours_sum: number;
}

export interface InstrumentMetrics {
  winRate: number | null;       // % of closed trades with net P/L > 0
  longWinRate: number | null;
  shortWinRate: number | null;
  profitFactor: number | null;  // gross profit / gross loss
  expectancyR: number | null;   // average R per closed trade
  avgWin: number | null;
  avgLoss: number | null;       // negative number
  payoff: number | null;        // avg win / |avg loss|
  avgPnl: number | null;        // net P/L per closed trade
  avgHoldHours: number | null;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function metrics(s: InstrumentAgg): InstrumentMetrics {
  const avgWin = ratio(s.gross_profit, s.wins);
  const avgLoss = s.losses > 0 ? -s.gross_loss / s.losses : null;
  return {
    winRate: s.closed_trades > 0 ? (s.wins / s.closed_trades) * 100 : null,
    longWinRate: s.long_closed > 0 ? (s.long_wins / s.long_closed) * 100 : null,
    shortWinRate: s.short_closed > 0 ? (s.short_wins / s.short_closed) * 100 : null,
    profitFactor: s.gross_loss > 0 ? s.gross_profit / s.gross_loss : s.gross_profit > 0 ? Infinity : null,
    expectancyR: ratio(s.total_r, s.r_count),
    avgWin,
    avgLoss,
    payoff: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / -avgLoss : null,
    avgPnl: ratio(s.net_pnl, s.closed_trades),
    avgHoldHours: ratio(s.hold_hours_sum, s.closed_trades),
  };
}

const SUM_KEYS = [
  "trades_total", "open_trades", "closed_trades", "wins", "losses", "long_closed", "long_wins", "short_closed", "short_wins",
  "net_pnl", "gross_profit", "gross_loss", "costs", "open_pnl", "r_count", "total_r", "hold_hours_sum",
] as const;

/** Exact roll-up of several rows (e.g. all instruments in a group). */
export function sumAgg(rows: InstrumentAgg[]): InstrumentAgg {
  const out = Object.fromEntries(SUM_KEYS.map((k) => [k, 0])) as unknown as InstrumentAgg;
  out.best_r = null;
  out.worst_r = null;
  for (const r of rows) {
    for (const k of SUM_KEYS) out[k] += Number(r[k] ?? 0);
    if (r.best_r !== null && (out.best_r === null || r.best_r > out.best_r)) out.best_r = r.best_r;
    if (r.worst_r !== null && (out.worst_r === null || r.worst_r < out.worst_r)) out.worst_r = r.worst_r;
  }
  return out;
}

/** Broker asset classes (MT5 symbol path) mapped to dashboard groups. */
export const GROUPS = [
  { key: "indices", label: "Indeksy", classes: ["Cash Indices CFDs", "Index Futures CFDs"] },
  { key: "commodities", label: "Surowce", classes: ["Metals", "Energies", "Agricultures", "Commodity Futures CFDs"] },
  { key: "forex", label: "Waluty", classes: ["Forex"] },
  { key: "crypto", label: "Krypto", classes: ["Cryptocurrencies"] },
  { key: "stocks", label: "Akcje", classes: ["Stock CFDs"] },
] as const;

export type GroupKey = (typeof GROUPS)[number]["key"] | "other";

export function groupOf(assetClass: string | null): GroupKey {
  if (!assetClass) return "other";
  return GROUPS.find((g) => (g.classes as readonly string[]).includes(assetClass))?.key ?? "other";
}

export function groupLabel(key: GroupKey): string {
  return GROUPS.find((g) => g.key === key)?.label ?? "Inne";
}

const SUBCLASS: Record<string, string> = {
  "Cash Indices CFDs": "indeks cash",
  "Index Futures CFDs": "indeks futures",
  Metals: "metal",
  Energies: "energia",
  Agricultures: "rolny",
  "Commodity Futures CFDs": "surowiec futures",
  Forex: "waluta",
  Cryptocurrencies: "krypto",
  "Stock CFDs": "akcja",
};

export function subclassLabel(assetClass: string | null): string {
  return assetClass ? (SUBCLASS[assetClass] ?? assetClass) : "—";
}

export function instrumentHref(symbol: string): string {
  return `/instruments/${encodeURIComponent(symbol)}`;
}

export function fmtHours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} h`;
  return `${(h / 24).toLocaleString("pl-PL", { maximumFractionDigits: 1 })} dni`;
}
