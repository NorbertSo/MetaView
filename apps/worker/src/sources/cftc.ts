import type { Ctx } from "../context.js";

// CFTC Public Reporting (Socrata) — Legacy Futures Only report.
const ENDPOINT = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";

/**
 * CFTC contract market codes tracked: FX majors and USD index, US indices and VIX, metals, energy, softs.
 * European indices (DAX, Euro Stoxx, CAC…) trade on Eurex/Euronext and are not in CFTC reports.
 */
export const COT_MARKETS: Record<string, string> = {
  "099741": "EURO FX", "096742": "BRITISH POUND", "097741": "JAPANESE YEN", "092741": "SWISS FRANC",
  "090741": "CANADIAN DOLLAR", "232741": "AUSTRALIAN DOLLAR", "112741": "NZ DOLLAR", "098662": "USD INDEX",
  "13874A": "E-MINI S&P 500", "209742": "NASDAQ MINI", "124603": "DJIA x $5", "239742": "RUSSELL E-MINI",
  "240743": "NIKKEI (YEN)", "1170E1": "VIX FUTURES",
  "088691": "GOLD", "084691": "SILVER", "076651": "PLATINUM", "075651": "PALLADIUM", "085692": "COPPER",
  "067651": "WTI CRUDE OIL", "06765T": "BRENT LAST DAY", "023651": "NATURAL GAS (NYMEX)",
  "073732": "COCOA", "083731": "COFFEE C", "080732": "SUGAR NO. 11", "033661": "COTTON NO. 2", "040701": "ORANGE JUICE",
  "133741": "BITCOIN (CME)",
};

/** Broker symbols each COT market is relevant for (Admirals naming). */
export const COT_SYMBOLS: Record<string, string[]> = {
  "099741": ["EURUSD"], "096742": ["GBPUSD"], "097741": ["USDJPY"], "092741": ["USDCHF"], "090741": ["USDCAD"],
  "232741": ["AUDUSD"], "112741": ["NZDUSD"], "13874A": ["[SP500]"], "209742": ["US100"], "124603": ["[DJI30]"],
  "240743": ["[JP225]"], "088691": ["GOLD", "XAUEUR"], "084691": ["SILVER"], "076651": ["PLATINUM"], "075651": ["PALLADIUM"],
  "085692": ["COPPER"], "067651": ["CRUDOIL"], "06765T": ["BRENT"], "023651": ["NGAS"], "073732": ["COCOA"],
  "083731": ["ARABICA"], "080732": ["SUGAR.RAW"], "033661": ["COTTON"], "040701": ["ORANGE.JUICE"], "133741": ["BTCUSD"],
};

interface Row {
  report_date_as_yyyy_mm_dd: string; market_and_exchange_names: string; cftc_contract_market_code: string;
  open_interest_all?: string; noncomm_positions_long_all?: string; noncomm_positions_short_all?: string;
  comm_positions_long_all?: string; comm_positions_short_all?: string;
  nonrept_positions_long_all?: string; nonrept_positions_short_all?: string;
}

const num = (s: string | undefined) => (s === undefined || s === "" ? null : Math.round(Number(s)));

export async function fetchCot(ctx: Ctx, weeks?: number): Promise<number> {
  if (weeks === undefined) {
    // Backfill a year for markets that were added recently; otherwise refresh the last few weeks.
    const [r] = await ctx.sql<{ thin: number }[]>`
      select count(*)::int as thin from unnest(${Object.keys(COT_MARKETS)}::text[]) as code
      where (select count(*) from cot_reports where market_code = code) < 20`;
    weeks = r && r.thin > 0 ? 52 : 6;
  }
  const codes = Object.keys(COT_MARKETS).map((c) => `'${c}'`).join(",");
  const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString().slice(0, 10);
  const url = `${ENDPOINT}?$where=${encodeURIComponent(`cftc_contract_market_code in (${codes}) AND report_date_as_yyyy_mm_dd >= '${since}'`)}&$limit=5000`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`CFTC HTTP ${res.status}`);
  const rows = (await res.json()) as Row[];
  if (!Array.isArray(rows)) throw new Error("CFTC: unexpected payload");
  let n = 0;
  for (const r of rows) {
    const date = r.report_date_as_yyyy_mm_dd?.slice(0, 10);
    if (!date || !r.cftc_contract_market_code) continue;
    await ctx.sql`
      insert into cot_reports (report_date, market_code, market_name, open_interest, noncomm_long, noncomm_short,
                               comm_long, comm_short, nonrept_long, nonrept_short, source)
      values (${date}, ${r.cftc_contract_market_code}, ${r.market_and_exchange_names}, ${num(r.open_interest_all)},
              ${num(r.noncomm_positions_long_all)}, ${num(r.noncomm_positions_short_all)}, ${num(r.comm_positions_long_all)},
              ${num(r.comm_positions_short_all)}, ${num(r.nonrept_positions_long_all)}, ${num(r.nonrept_positions_short_all)}, 'cftc')
      on conflict (report_date, market_code) do update set
        open_interest = excluded.open_interest, noncomm_long = excluded.noncomm_long, noncomm_short = excluded.noncomm_short,
        comm_long = excluded.comm_long, comm_short = excluded.comm_short, nonrept_long = excluded.nonrept_long, nonrept_short = excluded.nonrept_short`;
    n++;
  }
  return n;
}
