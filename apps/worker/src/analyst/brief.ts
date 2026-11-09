import { z } from "zod";
import type { Ctx } from "../context.js";
import { systemEvent } from "../events.js";
import { callModel } from "../llm/client.js";
import { getSetting } from "../settings.js";

const BriefOut = z.object({
  regime: z.enum(["risk_on", "risk_off", "mixed", "unknown"]),
  summary_md: z.string().min(20).max(8000),
  central_banks: z.array(z.object({ bank: z.string(), stance: z.string(), next_meeting: z.string().nullable(), notes: z.string() })).max(12),
  calendar: z.array(z.object({ time_utc: z.string(), currency: z.string(), title: z.string(), importance: z.string(), note: z.string() })).max(40),
  instruments: z.record(z.object({ bias: z.enum(["long", "short", "neutral"]), confidence: z.number().min(0).max(1), notes: z.string() })),
  confidence: z.number().min(0).max(1),
  source_refs: z.object({ news: z.array(z.string()), events: z.array(z.string()) }),
});

const briefSchema = {
  type: "object", additionalProperties: false,
  required: ["regime", "summary_md", "central_banks", "calendar", "instruments", "confidence", "source_refs"],
  properties: {
    regime: { type: "string", enum: ["risk_on", "risk_off", "mixed", "unknown"] },
    summary_md: { type: "string", description: "Markdown overview, 150-400 words." },
    central_banks: { type: "array", items: { type: "object", additionalProperties: false, required: ["bank", "stance", "next_meeting", "notes"],
      properties: { bank: { type: "string" }, stance: { type: "string" }, next_meeting: { type: ["string", "null"] }, notes: { type: "string" } } } },
    calendar: { type: "array", items: { type: "object", additionalProperties: false, required: ["time_utc", "currency", "title", "importance", "note"],
      properties: { time_utc: { type: "string" }, currency: { type: "string" }, title: { type: "string" }, importance: { type: "string" }, note: { type: "string" } } } },
    instruments: { type: "object", description: "Keyed by broker symbol from the input list.",
      additionalProperties: { type: "object", additionalProperties: false, required: ["bias", "confidence", "notes"],
        properties: { bias: { type: "string", enum: ["long", "short", "neutral"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, notes: { type: "string" } } } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    source_refs: { type: "object", additionalProperties: false, required: ["news", "events"],
      properties: { news: { type: "array", items: { type: "string" } }, events: { type: "array", items: { type: "string" } } } },
  },
} as const;

const SYSTEM = `You are the market analyst for a set of automated trading agents. You write one shared brief that all strategies read.
Rules:
- Use ONLY the data provided (events, news, COT). Never invent figures, dates or quotes. If data is thin, say so and lower confidence.
- Cite the ids of the news items and events you relied on in source_refs.
- Be specific about what matters in the next 1-3 days and why. Bias per instrument must be justified by the provided data.
Answer only via the submit_brief tool.`;

export async function generateBrief(ctx: Ctx): Promise<string | null> {
  const cfg = await getSetting(ctx, "analyst");
  if (!cfg.model_id) {
    await systemEvent(ctx, "warn", "analyst", "no_model", "Analityk nie ma przypisanego modelu (Ustawienia → Analityk).", { telegram: false });
    return null;
  }
  const instruments = (await ctx.sql<{ symbol: string }[]>`
    select distinct unnest(instruments) as symbol from agents where status in ('active','paused') order by 1`).map((r) => r.symbol);
  const events = await ctx.sql<{ id: string; scheduled_at: Date; currency: string | null; title: string; importance: string; forecast_raw: string | null; previous_raw: string | null; actual_raw: string | null; surprise: number | null }[]>`
    select id, scheduled_at, currency, title, importance, forecast_raw, previous_raw, actual_raw, surprise from economic_events
    where scheduled_at between now() - interval '36 hours' and now() + interval '4 days' and importance in ('medium','high')
    order by scheduled_at`;
  const news = await ctx.sql<{ id: string; published_at: Date; source: string; title: string; summary: string | null; importance: number | null; instruments: string[] }[]>`
    select id, published_at, source, title, summary, importance, instruments from news_items
    where published_at > now() - interval '36 hours' order by coalesce(importance, 3) desc, published_at desc limit 80`;
  const cot = await ctx.sql<{ market_name: string; report_date: Date; noncomm_net: number | null; open_interest: number | null }[]>`
    select distinct on (market_code) market_name, report_date, noncomm_net, open_interest from cot_reports order by market_code, report_date desc`;

  const res = await callModel(ctx, {
    modelId: cfg.model_id, purpose: "brief", system: SYSTEM, temperature: 0.2, maxOutputTokens: 6000,
    user: JSON.stringify({ now_utc: new Date().toISOString(), instruments, economic_events: events, news, cot_latest: cot }),
    tool: { name: "submit_brief", description: "Submit the market brief.", inputSchema: briefSchema as unknown as Record<string, unknown> },
  });
  const out = BriefOut.parse(res.toolInput);
  const validIds = new Set([...events.map((e) => e.id), ...news.map((n) => n.id)]);
  const refs = { news: out.source_refs.news.filter((id) => validIds.has(id)), events: out.source_refs.events.filter((id) => validIds.has(id)) };
  const [row] = await ctx.sql<{ id: string }[]>`
    insert into market_briefs (valid_until, produced_by, llm_call_id, prompt_version, regime, summary_md, central_banks, calendar, instruments, source_refs, confidence)
    values (now() + make_interval(hours => ${cfg.valid_hours}), 'analyst', ${res.callId}, ${cfg.prompt_version}, ${out.regime}, ${out.summary_md},
            ${ctx.sql.json(out.central_banks as never)}, ${ctx.sql.json(out.calendar as never)}, ${ctx.sql.json(out.instruments as never)},
            ${ctx.sql.json(refs as never)}, ${out.confidence})
    returning id`;
  return row!.id;
}
