import { matchEvents, toUnit, type CalendarEvent } from "@tv/core";
import type { Ctx } from "../context.js";

/**
 * The ForexFactory weekly feed has forecasts and previous values but never the actual figure.
 * TradingView's public economic calendar publishes actuals within a minute or two of the release,
 * so we fill `actual` on our ForexFactory rows from it.
 */
const ENDPOINT = "https://economic-calendar.tradingview.com/events";

interface TvEvent {
  title: string; currency?: string; date: string;
  actual: number | null; forecast: number | null; previous: number | null;
  unit?: string | null; scale?: string | null;
}

interface PendingRow { id: string; scheduled_at: Date; currency: string | null; title: string; forecast: number | null; previous: number | null; unit: string | null }

/** Fills missing actuals for events released in the last 36 hours. Returns the number of events updated. */
export async function fillActuals(ctx: Ctx): Promise<number> {
  const pending = await ctx.sql<PendingRow[]>`
    select id, scheduled_at, currency, title, forecast, previous, unit from economic_events
    where actual is null and importance <> 'holiday'
      and scheduled_at between now() - interval '36 hours' and now() + interval '1 minute'`;
  if (pending.length === 0) return 0;

  const from = new Date(Math.min(...pending.map((p) => p.scheduled_at.getTime())) - 10 * 60_000);
  const to = new Date(Date.now() + 10 * 60_000);
  const url = `${ENDPOINT}?from=${from.toISOString()}&to=${to.toISOString()}`;
  const res = await fetch(url, {
    headers: { origin: "https://www.tradingview.com", referer: "https://www.tradingview.com/", "user-agent": "Mozilla/5.0 trading-v5v/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`TradingView calendar HTTP ${res.status}`);
  const body = (await res.json()) as { status?: string; result?: TvEvent[] };
  if (!Array.isArray(body.result)) throw new Error("TradingView calendar: unexpected payload");
  const released = body.result.filter((e) => e.actual !== null && e.actual !== undefined && Number.isFinite(e.actual));

  const targets: CalendarEvent[] = pending.map((p) => ({ title: p.title, currency: p.currency, at: p.scheduled_at, forecast: p.forecast, previous: p.previous }));
  const candidates: CalendarEvent[] = released.map((e) => ({ title: e.title, currency: e.currency ?? null, at: new Date(e.date), forecast: e.forecast, previous: e.previous }));
  const matches = matchEvents(targets, candidates);

  let n = 0;
  for (const [ti, ci] of matches) {
    const row = pending[ti]!, tv = released[ci]!;
    const { value, raw } = toUnit(tv.actual as number, tv.unit ?? null, tv.scale ?? null, row.unit);
    const updated = await ctx.sql`
      update economic_events set actual = ${value}, actual_raw = ${raw}, published_at = coalesce(published_at, now())
      where id = ${row.id} and actual is null`;
    n += updated.count;
  }
  if (n > 0) ctx.log.info({ filled: n, pending: pending.length }, "economic actuals filled from TradingView");
  return n;
}

/** True when an event was due in the last 30 minutes and still has no actual: poll every minute then. */
export async function actualsDueSoon(ctx: Ctx): Promise<boolean> {
  const [r] = await ctx.sql<{ due: boolean }[]>`
    select exists (select 1 from economic_events where actual is null and importance in ('medium','high','low')
                   and scheduled_at between now() - interval '30 minutes' and now()) as due`;
  return !!r?.due;
}
