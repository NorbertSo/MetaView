import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseFigure } from "@tv/core";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 500;
const MAX_BYTES = 2 * 1024 * 1024;

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid ISO date");
const symbol = z.string().min(1).max(32);

const NewsItem = z.object({
  source: z.string().min(1).max(64),
  source_item_id: z.string().min(1).max(256),
  title: z.string().min(1).max(500),
  summary: z.string().max(2000).nullish(),
  url: z.string().url().max(2000).nullish(),
  published_at: isoDate,
  instruments: z.array(symbol).max(20).default([]),
  tags: z.array(z.string().max(48)).max(20).default([]),
  importance: z.number().int().min(1).max(5).nullish(),
  sentiment: z.number().min(-1).max(1).nullish(),
});

const EventItem = z.object({
  source: z.string().min(1).max(64),
  source_event_id: z.string().min(1).max(256),
  scheduled_at: isoDate,
  country: z.string().max(64).nullish(),
  currency: z.string().length(3).nullish(),
  title: z.string().min(1).max(300),
  importance: z.enum(["low", "medium", "high", "holiday"]),
  forecast: z.union([z.string().max(32), z.number()]).nullish(),
  previous: z.union([z.string().max(32), z.number()]).nullish(),
  actual: z.union([z.string().max(32), z.number()]).nullish(),
});

const Brief = z.object({
  regime: z.enum(["risk_on", "risk_off", "mixed", "unknown"]),
  summary_md: z.string().min(20).max(8000),
  valid_hours: z.number().min(1).max(72).default(12),
  central_banks: z.array(z.object({ bank: z.string(), stance: z.string(), next_meeting: z.string().nullable(), notes: z.string() })).max(12).default([]),
  calendar: z.array(z.record(z.unknown())).max(40).default([]),
  instruments: z.record(z.object({ bias: z.enum(["long", "short", "neutral"]), confidence: z.number().min(0).max(1), notes: z.string().max(1000) })).default({}),
  confidence: z.number().min(0).max(1).nullish(),
});

const Journal = z.object({ kind: z.enum(["observation", "idea", "decision", "note"]), body: z.string().min(1).max(4000) });

type Feed = "news" | "economic_events" | "market_briefs" | "journal";
const FEEDS: Feed[] = ["news", "economic_events", "market_briefs", "journal"];

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Write-only endpoint for external producers (Apify, n8n, Claude scheduled tasks).
 * Auth: per-source bearer token (only its SHA-256 is stored), scoped per feed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ feed: string }> }) {
  const { feed } = await params;
  if (!FEEDS.includes(feed as Feed)) return err(404, "unknown feed");
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("tvi_")) return err(401, "missing or malformed bearer token");

  const sql = db();
  const hash = createHash("sha256").update(token).digest("hex");
  const [tok] = await sql<{ id: string; source_id: string; scopes: string[]; revoked_at: Date | null; kind: string; enabled: boolean; code: string }[]>`
    select t.id, t.source_id, t.scopes, t.revoked_at, s.kind, s.enabled, s.code
    from ingest_tokens t join data_sources s on s.id = t.source_id where t.token_hash = ${hash}`;
  if (!tok || tok.revoked_at) return err(401, "invalid token");
  if (!tok.enabled) return err(403, "source disabled");
  if (!tok.scopes.includes(feed)) return err(403, `token has no "${feed}" scope`);

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) return err(413, "payload too large");
  let body: unknown;
  try { body = await req.json(); } catch { return err(400, "invalid JSON"); }

  const idem = req.headers.get("idempotency-key")?.slice(0, 200) ?? null;
  if (idem) {
    const [dup] = await sql<{ status: string; accepted: number; rejected: number }[]>`
      select status, accepted, rejected from ingest_log where source_id = ${tok.source_id} and feed = ${feed} and idempotency_key = ${idem}`;
    if (dup) return NextResponse.json({ duplicate: true, ...dup });
  }

  let accepted = 0;
  const rejected: { index: number; error: string }[] = [];
  try {
    if (feed === "news" || feed === "economic_events") {
      const items = (body as { items?: unknown[] })?.items;
      if (!Array.isArray(items)) return err(400, 'expected { "items": [...] }');
      if (items.length > MAX_ITEMS) return err(413, `max ${MAX_ITEMS} items per request`);
      for (const [index, raw] of items.entries()) {
        if (feed === "news") {
          const p = NewsItem.safeParse(raw);
          if (!p.success) { rejected.push({ index, error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }); continue; }
          const n = p.data;
          await sql`
            insert into news_items (source, source_item_id, url, title, summary, published_at, instruments, tags, importance, sentiment, ingested_via)
            values (${n.source}, ${n.source_item_id}, ${n.url ?? null}, ${n.title}, ${n.summary ?? null}, ${new Date(n.published_at)}, ${n.instruments}, ${n.tags},
                    ${n.importance ?? null}, ${n.sentiment ?? null}, ${tok.code})
            on conflict (source, source_item_id) do update set
              title = excluded.title, summary = coalesce(excluded.summary, news_items.summary), instruments = excluded.instruments,
              tags = excluded.tags, importance = coalesce(excluded.importance, news_items.importance), sentiment = coalesce(excluded.sentiment, news_items.sentiment)`;
        } else {
          const p = EventItem.safeParse(raw);
          if (!p.success) { rejected.push({ index, error: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }); continue; }
          const e = p.data;
          const f = parseFigure(e.forecast), pr = parseFigure(e.previous), a = parseFigure(e.actual);
          const rawOf = (v: string | number | null | undefined) => (v === null || v === undefined ? null : String(v));
          await sql`
            insert into economic_events (source, source_event_id, scheduled_at, country, currency, title, importance, unit, forecast, previous, actual,
                                         forecast_raw, previous_raw, actual_raw, published_at)
            values (${e.source}, ${e.source_event_id}, ${new Date(e.scheduled_at)}, ${e.country ?? null}, ${e.currency?.toUpperCase() ?? null}, ${e.title},
                    ${e.importance}, ${f.unit ?? pr.unit ?? a.unit}, ${f.value}, ${pr.value}, ${a.value}, ${rawOf(e.forecast)}, ${rawOf(e.previous)}, ${rawOf(e.actual)},
                    ${a.value !== null ? new Date() : null})
            on conflict (source, source_event_id) do update set
              scheduled_at = excluded.scheduled_at, importance = excluded.importance,
              forecast = coalesce(excluded.forecast, economic_events.forecast), previous = coalesce(excluded.previous, economic_events.previous),
              actual = coalesce(excluded.actual, economic_events.actual), forecast_raw = coalesce(excluded.forecast_raw, economic_events.forecast_raw),
              previous_raw = coalesce(excluded.previous_raw, economic_events.previous_raw), actual_raw = coalesce(excluded.actual_raw, economic_events.actual_raw),
              published_at = coalesce(economic_events.published_at, excluded.published_at)`;
        }
        accepted++;
      }
    } else if (feed === "market_briefs") {
      const p = Brief.safeParse(body);
      if (!p.success) return err(422, p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const b = p.data;
      await sql`
        insert into market_briefs (valid_until, produced_by, prompt_version, regime, summary_md, central_banks, calendar, instruments, source_refs, confidence)
        values (now() + make_interval(hours => ${b.valid_hours}), ${tok.kind === "claude" ? "claude_scheduled" : "ingest"}, ${`ingest:${tok.code}`},
                ${b.regime}, ${b.summary_md}, ${sql.json(b.central_banks as never)}, ${sql.json(b.calendar as never)}, ${sql.json(b.instruments as never)},
                ${sql.json({ source: tok.code } as never)}, ${b.confidence ?? null})`;
      accepted = 1;
    } else {
      const p = Journal.safeParse(body);
      if (!p.success) return err(422, p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      await sql`insert into journal_entries (kind, body, via) values (${p.data.kind}, ${p.data.body}, 'api')`;
      accepted = 1;
    }
  } catch (e) {
    await sql`insert into ingest_log (token_id, source_id, feed, status, accepted, rejected, error, idempotency_key)
              values (${tok.id}, ${tok.source_id}, ${feed}, 'error', ${accepted}, ${rejected.length}, ${(e as Error).message.slice(0, 1000)}, ${idem})
              on conflict (source_id, feed, idempotency_key) do nothing`;
    await sql`update data_sources set last_error_at = now(), last_error = ${(e as Error).message.slice(0, 500)} where id = ${tok.source_id}`;
    return err(500, "ingest failed");
  }

  const status = rejected.length === 0 ? "ok" : accepted > 0 ? "partial" : "rejected";
  await sql`insert into ingest_log (token_id, source_id, feed, status, accepted, rejected, error, idempotency_key)
            values (${tok.id}, ${tok.source_id}, ${feed}, ${status}, ${accepted}, ${rejected.length},
                    ${rejected.length ? JSON.stringify(rejected.slice(0, 20)).slice(0, 2000) : null}, ${idem})
            on conflict (source_id, feed, idempotency_key) do nothing`;
  await sql`update ingest_tokens set last_used_at = now() where id = ${tok.id}`;
  if (accepted > 0) await sql`update data_sources set last_success_at = now() where id = ${tok.source_id}`;
  else await sql`update data_sources set last_error_at = now(), last_error = 'all items rejected' where id = ${tok.source_id}`;

  return NextResponse.json({ status, accepted, rejected }, { status: status === "rejected" ? 422 : 200 });
}
