import type { Ctx } from "../context.js";

// CFTC Public Reporting (Socrata) — Legacy Futures Only report.
const ENDPOINT = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";

/** CFTC contract market codes tracked by default (FX majors, metals, oil, US indices, USD index). */
export const COT_MARKETS: Record<string, string> = {
  "099741": "EURO FX", "096742": "BRITISH POUND", "097741": "JAPANESE YEN", "092741": "SWISS FRANC",
  "090741": "CANADIAN DOLLAR", "232741": "AUSTRALIAN DOLLAR", "112741": "NZ DOLLAR", "098662": "USD INDEX",
  "088691": "GOLD", "084691": "SILVER", "067651": "WTI CRUDE OIL", "13874A": "E-MINI S&P 500", "209742": "NASDAQ MINI",
};

interface Row {
  report_date_as_yyyy_mm_dd: string; market_and_exchange_names: string; cftc_contract_market_code: string;
  open_interest_all?: string; noncomm_positions_long_all?: string; noncomm_positions_short_all?: string;
  comm_positions_long_all?: string; comm_positions_short_all?: string;
  nonrept_positions_long_all?: string; nonrept_positions_short_all?: string;
}

const num = (s: string | undefined) => (s === undefined || s === "" ? null : Math.round(Number(s)));

export async function fetchCot(ctx: Ctx, weeks = 8): Promise<number> {
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
