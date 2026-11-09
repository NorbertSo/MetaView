import type { Ctx } from "../context.js";
import type { MetaApiManager } from "../metaapi/manager.js";
import { getSpec, recordSpread } from "../metaapi/instruments.js";

interface SymRow { symbol: string; acc_id: string; metaapi_account_id: string; server: string; style: string; agent_id: string }

async function activeSymbols(ctx: Ctx): Promise<SymRow[]> {
  return ctx.sql<SymRow[]>`
    select distinct on (m.server, s.symbol) s.symbol, m.id as acc_id, m.metaapi_account_id, m.server, st.style, a.id as agent_id
    from agents a cross join lateral unnest(a.instruments) as s(symbol)
    join mt_accounts m on m.id = a.mt_account_id
    join strategy_versions v on v.id = a.strategy_version_id join strategies st on st.id = v.strategy_id
    where a.status = 'active' and m.status = 'connected'`;
}

/** Every minute: sample spreads ±30 min around high-impact events for affected symbols. */
export async function sampleEventWindows(ctx: Ctx, mt: MetaApiManager): Promise<void> {
  const events = await ctx.sql<{ id: string; currency: string }[]>`
    select id, currency from economic_events
    where importance = 'high' and currency is not null and scheduled_at between now() - interval '30 minutes' and now() + interval '30 minutes'`;
  if (!events.length) return;
  for (const s of await activeSymbols(ctx)) {
    const acc = { id: s.acc_id, metaapi_account_id: s.metaapi_account_id, server: s.server };
    const spec = await getSpec(ctx, mt, acc, s.symbol);
    const ev = events.find((e) => e.currency === spec.currencyBase || e.currency === spec.currencyProfit);
    if (!ev) continue;
    const q = await mt.symbolPrice(s.metaapi_account_id, s.symbol);
    await recordSpread(ctx, s.server, s.symbol, q.bid, q.ask, spec.point, "event_window", ev.id);
  }
}

/** Every 5 min: compute price reactions for high-impact events that happened 65 min – 6 h ago. */
export async function computeEventReactions(ctx: Ctx, mt: MetaApiManager): Promise<void> {
  const events = await ctx.sql<{ id: string; currency: string; scheduled_at: Date }[]>`
    select id, currency, scheduled_at from economic_events
    where importance = 'high' and currency is not null
      and scheduled_at between now() - interval '6 hours' and now() - interval '65 minutes'`;
  if (!events.length) return;
  const symbols = await activeSymbols(ctx);
  for (const ev of events) {
    for (const s of symbols) {
      const [done] = await ctx.sql`select 1 from event_reactions where event_id = ${ev.id} and broker_server = ${s.server} and symbol = ${s.symbol}`;
      if (done) continue;
      const acc = { id: s.acc_id, metaapi_account_id: s.metaapi_account_id, server: s.server };
      const spec = await getSpec(ctx, mt, acc, s.symbol);
      if (ev.currency !== spec.currencyBase && ev.currency !== spec.currencyProfit) continue;
      // MetaApi returns candles before startTime (descending window); ask for 70 x 1m ending at T+62m.
      const candles = (await mt.candlesFrom(s.metaapi_account_id, s.symbol, "1m", new Date(ev.scheduled_at.getTime() + 62 * 60_000), 70))
        .map((c) => ({ ...c, t: new Date(c.time).getTime() })).sort((a, b) => a.t - b.t);
      const t0 = ev.scheduled_at.getTime();
      const before = candles.filter((c) => c.t < t0).at(-1);
      if (!before) continue;
      const at = (min: number) => candles.filter((c) => c.t <= t0 + min * 60_000 - 60_000).at(-1)?.close ?? null;
      const pts = (p: number | null) => (p === null ? null : Math.round(((p - before.close) / spec.point) * 100) / 100);
      const [sp] = await ctx.sql<{ max: number | null }[]>`
        select max(spread_points) as max from spread_samples where ref_id = ${ev.id} and broker_server = ${s.server} and symbol = ${s.symbol}`;
      await ctx.sql`
        insert into event_reactions (event_id, broker_server, symbol, price_before, move_1m_points, move_5m_points, move_15m_points, move_60m_points, max_spread_points)
        values (${ev.id}, ${s.server}, ${s.symbol}, ${before.close}, ${pts(at(1))}, ${pts(at(5))}, ${pts(at(15))}, ${pts(at(60))}, ${sp?.max ?? null})
        on conflict (event_id, broker_server, symbol) do nothing`;
    }
  }
}

/** Agents whose strategy is event-driven get triggered N minutes before relevant high-impact events. */
export async function dueEventTriggers(ctx: Ctx): Promise<{ agentId: string; eventId: string }[]> {
  return ctx.sql<{ agentId: string; eventId: string }[]>`
    select a.id as "agentId", e.id as "eventId"
    from agents a
    join strategy_versions v on v.id = a.strategy_version_id
    join strategies st on st.id = v.strategy_id
    join mt_accounts m on m.id = a.mt_account_id
    join economic_events e on e.importance = 'high'
      and e.scheduled_at between now() + make_interval(mins => coalesce((v.params->>'event_trigger_minutes_before')::int, 10)) - interval '30 seconds'
                             and now() + make_interval(mins => coalesce((v.params->>'event_trigger_minutes_before')::int, 10)) + interval '30 seconds'
    where a.status = 'active' and st.style = 'event' and m.status = 'connected'
      and exists (select 1 from instruments i where i.broker_server = m.server and i.symbol = any(a.instruments)
                  and e.currency in (i.currency_base, i.currency_profit))
      and not exists (select 1 from agent_runs r where r.agent_id = a.id and r.trigger = 'event' and r.trigger_ref = e.id::text)`;
}
