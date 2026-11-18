import "server-only";
import { db } from "./db";
import type { CostInputs, InstrumentRaw } from "./costs";

export interface CostRow extends CostInputs {
  symbol: string;
  description: string | null;
  asset_class: string | null;
  digits: number;
  currency_profit: string | null;
  quote_at: Date | null;
  margin_per_lot: number | null;
  margin_checked_at: Date | null;
  updated_at: Date;
  n_7d: number | null;
  median_7d: number | null;
  avg_7d: number | null;
  p90_7d: number | null;
  min_7d: number | null;
  max_7d: number | null;
  n_all: number | null;
  last_spread_at: Date | null;
  trade_lots: number | null;
  commission_per_lot: number | null;
  trade_swap: number | null;
  days_held: number | null;
  avg_abs_slippage_points: number | null;
}

export async function costRows(symbol?: string): Promise<CostRow[]> {
  const sql = db();
  const rows = await sql<(Omit<CostRow, "raw"> & { raw: InstrumentRaw | null })[]>`
    select i.symbol, i.description, i.asset_class, i.digits, i.point, i.tick_size, i.contract_size, i.currency_profit,
           i.swap_long, i.swap_short, i.last_bid, i.last_ask, i.tick_value, i.quote_at, i.margin_per_lot, i.margin_checked_at,
           i.updated_at, i.raw,
           s.n_7d, s.median_7d, s.avg_7d, s.p90_7d, s.min_7d, s.max_7d, s.n_all, s.last_at as last_spread_at,
           c.lots as trade_lots, c.commission_per_lot, c.swap as trade_swap, c.days_held, c.avg_abs_slippage_points
    from (select distinct on (symbol) * from instruments order by symbol, updated_at desc) i
    left join v_spread_stats s on s.broker_server = i.broker_server and s.symbol = i.symbol
    left join v_trade_costs c on c.symbol = i.symbol
    where (${symbol ?? null}::text is null or i.symbol = ${symbol ?? null})
    order by i.symbol`;
  return rows.map((r) => ({ ...r, raw: r.raw ?? {} }));
}
