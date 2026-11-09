import { createHash } from "node:crypto";
import { parseFigure } from "@tv/core";
import type { Ctx } from "../context.js";

const FEED = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

interface FfEvent { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string; actual?: string }

function importance(impact: string): "low" | "medium" | "high" | "holiday" {
  const i = impact.toLowerCase();
  if (i === "high") return "high";
  if (i === "medium") return "medium";
  if (i === "holiday") return "holiday";
  return "low";
}

/** Fetches this week's ForexFactory calendar and upserts it. Returns the number of events stored. */
export async function fetchForexFactory(ctx: Ctx): Promise<number> {
  const res = await fetch(FEED, { headers: { "user-agent": "trading-v5v/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ForexFactory feed HTTP ${res.status}`);
  const data = (await res.json()) as FfEvent[];
  if (!Array.isArray(data)) throw new Error("ForexFactory feed: unexpected payload");
  let n = 0;
  for (const e of data) {
    const when = new Date(e.date);
    if (Number.isNaN(when.getTime()) || !e.title) continue;
    const id = createHash("sha1").update(`${e.country}|${e.title}|${when.toISOString()}`).digest("hex").slice(0, 20);
    const f = parseFigure(e.forecast), p = parseFigure(e.previous), a = parseFigure(e.actual);
    const unit = f.unit ?? p.unit ?? a.unit;
    await ctx.sql`
      insert into economic_events (source, source_event_id, scheduled_at, country, currency, title, importance, unit,
                                   forecast, previous, actual, forecast_raw, previous_raw, actual_raw, published_at)
      values ('forexfactory', ${id}, ${when}, ${e.country}, ${e.country}, ${e.title}, ${importance(e.impact)}, ${unit},
              ${f.value}, ${p.value}, ${a.value}, ${e.forecast || null}, ${e.previous || null}, ${e.actual || null},
              ${a.value !== null ? new Date() : null})
      on conflict (source, source_event_id) do update set
        importance = excluded.importance, unit = coalesce(excluded.unit, economic_events.unit),
        forecast = coalesce(excluded.forecast, economic_events.forecast), previous = coalesce(excluded.previous, economic_events.previous),
        actual = coalesce(excluded.actual, economic_events.actual), forecast_raw = coalesce(excluded.forecast_raw, economic_events.forecast_raw),
        previous_raw = coalesce(excluded.previous_raw, economic_events.previous_raw), actual_raw = coalesce(excluded.actual_raw, economic_events.actual_raw),
        published_at = coalesce(economic_events.published_at, excluded.published_at)`;
    n++;
  }
  return n;
}
