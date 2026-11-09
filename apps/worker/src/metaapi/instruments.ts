import type { SymbolSpec } from "@tv/core";
import type { Ctx } from "../context.js";
import type { MetaApiManager } from "./manager.js";

export interface AccountRef { id: string; metaapi_account_id: string; server: string }

interface InstrumentRow {
  symbol: string; digits: number; point: number; tick_size: number; volume_min: number; volume_max: number;
  volume_step: number; stops_level: number | null; currency_base: string | null; currency_profit: string | null;
  updated_at: Date;
}

const MAX_AGE_MS = 24 * 3600_000;

function toSpec(r: InstrumentRow): SymbolSpec {
  return {
    symbol: r.symbol, digits: r.digits, point: r.point, tickSize: r.tick_size, volumeMin: r.volume_min,
    volumeMax: r.volume_max, volumeStep: r.volume_step, stopsLevelPoints: r.stops_level ?? 0,
    currencyBase: r.currency_base, currencyProfit: r.currency_profit,
  };
}

/** Returns the broker's symbol specification, refreshing the cached copy daily. */
export async function getSpec(ctx: Ctx, mt: MetaApiManager, acc: AccountRef, symbol: string): Promise<SymbolSpec> {
  const [row] = await ctx.sql<InstrumentRow[]>`
    select symbol, digits, point, tick_size, volume_min, volume_max, volume_step, stops_level, currency_base, currency_profit, updated_at
    from instruments where broker_server = ${acc.server} and symbol = ${symbol}`;
  if (row && Date.now() - row.updated_at.getTime() < MAX_AGE_MS) return toSpec(row);
  return toSpec(await refreshSpec(ctx, mt, acc, symbol));
}

export async function refreshSpec(ctx: Ctx, mt: MetaApiManager, acc: AccountRef, symbol: string): Promise<InstrumentRow> {
  const s = await mt.symbolSpecification(acc.metaapi_account_id, symbol);
  const assetClass = s.path ? s.path.split(/[\\/]/)[0] ?? null : null;
  const [row] = await ctx.sql<InstrumentRow[]>`
    insert into instruments (broker_server, symbol, description, asset_class, digits, point, contract_size, tick_size,
                             volume_min, volume_max, volume_step, currency_base, currency_profit, currency_margin,
                             swap_long, swap_short, trade_mode, filling_modes, stops_level, raw, updated_at)
    values (${acc.server}, ${s.symbol}, ${s.description ?? null}, ${assetClass}, ${s.digits}, ${s.point}, ${s.contractSize ?? null},
            ${s.tickSize}, ${s.minVolume}, ${s.maxVolume}, ${s.volumeStep}, ${s.baseCurrency ?? null}, ${s.profitCurrency ?? null},
            ${s.marginCurrency ?? null}, ${s.swapLong ?? null}, ${s.swapShort ?? null}, ${s.tradeMode ?? null},
            ${ctx.sql.json((s.fillingModes ?? []) as never)}, ${s.stopsLevel ?? 0}, ${ctx.sql.json(JSON.parse(JSON.stringify(s)) as never)}, now())
    on conflict (broker_server, symbol) do update set
      description = excluded.description, asset_class = excluded.asset_class, digits = excluded.digits, point = excluded.point,
      contract_size = excluded.contract_size, tick_size = excluded.tick_size, volume_min = excluded.volume_min,
      volume_max = excluded.volume_max, volume_step = excluded.volume_step, currency_base = excluded.currency_base,
      currency_profit = excluded.currency_profit, currency_margin = excluded.currency_margin, swap_long = excluded.swap_long,
      swap_short = excluded.swap_short, trade_mode = excluded.trade_mode, filling_modes = excluded.filling_modes,
      stops_level = excluded.stops_level, raw = excluded.raw, updated_at = now()
    returning symbol, digits, point, tick_size, volume_min, volume_max, volume_step, stops_level, currency_base, currency_profit, updated_at`;
  return row!;
}

/** Median spread in points over the last 7 days, or null if there is not enough data. */
export async function medianSpread(ctx: Ctx, server: string, symbol: string): Promise<number | null> {
  const [r] = await ctx.sql<{ median: number | null; n: number }[]>`
    select percentile_cont(0.5) within group (order by spread_points) as median, count(*)::int as n
    from spread_samples
    where broker_server = ${server} and symbol = ${symbol} and context in ('periodic','decision')
      and sampled_at > now() - interval '7 days'`;
  return r && r.n >= 20 ? r.median : null;
}

export async function recordSpread(ctx: Ctx, server: string, symbol: string, bid: number, ask: number, point: number,
  context: "decision" | "entry" | "event_window" | "periodic", refId: string | null = null): Promise<void> {
  await ctx.sql`
    insert into spread_samples (broker_server, symbol, bid, ask, spread_points, context, ref_id)
    values (${server}, ${symbol}, ${bid}, ${ask}, ${Math.round(((ask - bid) / point) * 100) / 100}, ${context}, ${refId})`;
}
