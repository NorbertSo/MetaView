import type { Ctx } from "../context.js";
import type { MetaApiManager } from "../metaapi/manager.js";
import { getSpec, recordSpread, type AccountRef } from "../metaapi/instruments.js";

export interface AgentFull {
  id: string; code: string; name: string; magic: number; status: string; instruments: string[];
  allocated_capital: number; risk_per_trade_pct: number; max_open_positions: number; max_daily_loss_pct: number;
  max_drawdown_pct: number; temperature: number;
  strategy_id: string; strategy_code: string; style: "swing" | "day" | "event" | "other";
  strategy_version_id: string; version: number; rules_md: string; system_prompt: string;
  params: { candles?: Record<string, number>; news_hours?: number; events_hours_ahead?: number } & Record<string, unknown>;
  timeframes: string[];
  model_id: string;
  acc_id: string; metaapi_account_id: string; server: string; account_type: "demo" | "real"; account_status: string;
}

export async function loadAgent(ctx: Ctx, agentId: string): Promise<AgentFull | null> {
  const [a] = await ctx.sql<AgentFull[]>`
    select a.id, a.code, a.name, a.magic, a.status, a.instruments, a.allocated_capital, a.risk_per_trade_pct,
           a.max_open_positions, a.max_daily_loss_pct, a.max_drawdown_pct, a.temperature,
           s.id as strategy_id, s.code as strategy_code, s.style,
           v.id as strategy_version_id, v.version, v.rules_md, v.system_prompt, v.params, v.timeframes,
           a.model_id,
           m.id as acc_id, m.metaapi_account_id, m.server, m.account_type, m.status as account_status
    from agents a
    join strategy_versions v on v.id = a.strategy_version_id
    join strategies s on s.id = v.strategy_id
    join mt_accounts m on m.id = a.mt_account_id
    where a.id = ${agentId}`;
  return a ?? null;
}

export interface BuiltContext {
  json: Record<string, unknown>;
  briefId: string | null;
  lessonIds: string[];
  quotes: Map<string, { bid: number; ask: number; lossTickValue: number }>;
  positionsByRef: Map<string, string>; // position_ref -> trade id
  equity: number;
  peakEquity: number;
  dayStartEquity: number;
}

const DEFAULT_CANDLES: Record<string, number> = { "1h": 120, "4h": 120, "1d": 120 };

export async function buildContext(ctx: Ctx, mt: MetaApiManager, a: AgentFull): Promise<BuiltContext> {
  const acc: AccountRef = { id: a.acc_id, metaapi_account_id: a.metaapi_account_id, server: a.server };
  const now = new Date();

  const [eq] = await ctx.sql<{ equity: number; realized_pnl: number; unrealized_pnl: number }[]>`
    select equity, realized_pnl, unrealized_pnl from v_agent_equity where agent_id = ${a.id}`;
  const equity = eq?.equity ?? a.allocated_capital;
  const [pk] = await ctx.sql<{ peak: number | null }[]>`select max(equity) as peak from agent_equity_snapshots where agent_id = ${a.id}`;
  const peakEquity = Math.max(pk?.peak ?? a.allocated_capital, equity, a.allocated_capital);
  // Equity at the start of the UTC day: last snapshot before midnight, else first snapshot today, else allocation.
  const [ds] = await ctx.sql<{ equity: number | null }[]>`
    select coalesce(
      (select equity from agent_equity_snapshots where agent_id = ${a.id} and taken_at < date_trunc('day', now()) order by taken_at desc limit 1),
      (select equity from agent_equity_snapshots where agent_id = ${a.id} and taken_at >= date_trunc('day', now()) order by taken_at asc limit 1)
    ) as equity`;
  const dayStartEquity = ds?.equity ?? a.allocated_capital;

  const trades = await ctx.sql<{ id: string; position_id: string; symbol: string; direction: string; volume_open: number; entry_price: number;
    current_sl: number | null; current_tp: number | null; unrealized_pnl: number; risk_amount: number; opened_at: Date; rationale: string | null }[]>`
    select t.id, t.position_id, t.symbol, t.direction, t.volume_open, t.entry_price, t.current_sl, t.current_tp, t.unrealized_pnl,
           t.risk_amount, t.opened_at, d.rationale
    from trades t left join decisions d on d.id = t.open_decision_id
    where t.agent_id = ${a.id} and t.status = 'open' order by t.opened_at`;
  const positionsByRef = new Map<string, string>();
  const positions = trades.map((t) => {
    const ref = `P${t.position_id}`;
    positionsByRef.set(ref, t.id);
    return {
      position_ref: ref, symbol: t.symbol, direction: t.direction, volume: t.volume_open, entry: t.entry_price,
      stop_loss: t.current_sl, take_profit: t.current_tp, unrealized_pnl: t.unrealized_pnl,
      r_now: Math.round((t.unrealized_pnl / t.risk_amount) * 100) / 100, opened_at: t.opened_at.toISOString(),
      open_rationale: t.rationale,
    };
  });

  const tfCounts = a.params.candles && Object.keys(a.params.candles).length ? a.params.candles
    : a.timeframes.length ? Object.fromEntries(a.timeframes.map((tf) => [tf, 120])) : DEFAULT_CANDLES;
  const quotes = new Map<string, { bid: number; ask: number; lossTickValue: number }>();
  const market: Record<string, unknown> = {};
  const currencies = new Set<string>();
  for (const symbol of a.instruments) {
    const spec = await getSpec(ctx, mt, acc, symbol);
    if (spec.currencyBase) currencies.add(spec.currencyBase);
    if (spec.currencyProfit) currencies.add(spec.currencyProfit);
    const q = await mt.symbolPrice(a.metaapi_account_id, symbol);
    quotes.set(symbol, { bid: q.bid, ask: q.ask, lossTickValue: q.lossTickValue });
    await recordSpread(ctx, a.server, symbol, q.bid, q.ask, spec.point, "decision");
    const candles: Record<string, unknown[]> = {};
    for (const [tf, n] of Object.entries(tfCounts)) {
      const list = await mt.candles(a.metaapi_account_id, symbol, tf, Math.min(Math.max(n, 10), 500));
      candles[tf] = list
        .sort((x, y) => new Date(x.time).getTime() - new Date(y.time).getTime())
        .map((c) => [new Date(c.time).toISOString(), c.open, c.high, c.low, c.close, c.tickVolume]);
    }
    market[symbol] = {
      bid: q.bid, ask: q.ask, spread_points: Math.round(((q.ask - q.bid) / spec.point) * 10) / 10, digits: spec.digits,
      point: spec.point, min_stop_distance_points: spec.stopsLevelPoints, quote_time: new Date(q.time).toISOString(),
      candles_format: "[time_utc, open, high, low, close, tick_volume], oldest first; last candle may be still forming",
      candles,
    };
  }

  const [brief] = await ctx.sql<{ id: string; created_at: Date; valid_until: Date; regime: string; summary_md: string; central_banks: unknown; instruments: Record<string, unknown>; confidence: number | null }[]>`
    select id, created_at, valid_until, regime, summary_md, central_banks, instruments, confidence
    from market_briefs where valid_until > now() order by created_at desc limit 1`;

  const hoursAhead = a.params.events_hours_ahead ?? 72;
  const ccys = [...currencies];
  const events = ccys.length ? await ctx.sql<{ scheduled_at: Date; currency: string; title: string; importance: string; forecast_raw: string | null; previous_raw: string | null; actual_raw: string | null; surprise: number | null }[]>`
    select scheduled_at, currency, title, importance, forecast_raw, previous_raw, actual_raw, surprise
    from economic_events
    where currency = any(${ccys}) and importance in ('medium','high')
      and scheduled_at between now() - interval '24 hours' and now() + make_interval(hours => ${hoursAhead})
    order by scheduled_at` : [];

  const newsHours = a.params.news_hours ?? 24;
  const news = await ctx.sql<{ published_at: Date; title: string; summary: string | null; source: string; importance: number | null; instruments: string[] }[]>`
    select published_at, title, summary, source, importance, instruments
    from news_items
    where published_at > now() - make_interval(hours => ${newsHours})
      and (instruments && ${a.instruments} or cardinality(instruments) = 0)
    order by coalesce(importance, 3) desc, published_at desc limit 30`;

  const lessons = await ctx.sql<{ id: string; body: string }[]>`
    select id, body from lessons where strategy_id = ${a.strategy_id} and status = 'approved' order by decided_at`;

  const json = {
    now_utc: now.toISOString(),
    agent: {
      code: a.code, strategy: a.strategy_code, strategy_version: a.version, style: a.style,
      instruments: a.instruments, risk_per_trade_pct: a.risk_per_trade_pct,
      allocated_capital: a.allocated_capital, equity, realized_pnl: eq?.realized_pnl ?? 0, unrealized_pnl: eq?.unrealized_pnl ?? 0,
      today_pnl: Math.round((equity - dayStartEquity) * 100) / 100,
      drawdown_from_peak_pct: Math.round(((peakEquity - equity) / peakEquity) * 10000) / 100,
      max_open_positions: a.max_open_positions,
    },
    positions,
    market,
    market_brief: brief ? {
      created_at: brief.created_at.toISOString(), valid_until: brief.valid_until.toISOString(), regime: brief.regime,
      summary: brief.summary_md, central_banks: brief.central_banks,
      instruments: Object.fromEntries(Object.entries(brief.instruments ?? {}).filter(([k]) => a.instruments.includes(k))),
      confidence: brief.confidence,
    } : null,
    economic_events: events.map((e) => ({
      time_utc: e.scheduled_at.toISOString(), currency: e.currency, title: e.title, importance: e.importance,
      forecast: e.forecast_raw, previous: e.previous_raw, actual: e.actual_raw, surprise: e.surprise,
    })),
    news: news.map((n) => ({ time_utc: n.published_at.toISOString(), source: n.source, title: n.title, summary: n.summary, importance: n.importance, instruments: n.instruments })),
    lessons: lessons.map((l) => l.body),
  };
  return { json, briefId: brief?.id ?? null, lessonIds: lessons.map((l) => l.id), quotes, positionsByRef, equity, peakEquity, dayStartEquity };
}
