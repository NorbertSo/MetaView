import { openPositionRisk } from "@tv/core";
import type { Ctx } from "../context.js";
import { systemEvent } from "../events.js";
import type { Deal, MetaApiManager, Position } from "../metaapi/manager.js";
import { getSpec, recordSpread, type AccountRef } from "../metaapi/instruments.js";
import { closeAllForAgent, recordOpenedTrade } from "./execution.js";
import { notify } from "../telegram.js";
import { getSetting } from "../settings.js";
import { escapeHtml } from "../events.js";

interface AccountRow extends AccountRef { name: string; status: string; account_type: string }
interface AgentRow { id: string; code: string; magic: number; status: string; max_drawdown_pct: number; name: string }
interface OpenTradeRow {
  id: string; agent_id: string; position_id: string; symbol: string; direction: "long" | "short";
  volume_open: number; current_sl: number | null; current_tp: number | null; entry_price: number;
  risk_amount: number; opened_at: Date; mae_price: number | null; mfe_price: number | null; open_decision_id: string | null;
}

const lastSnapshot = new Map<string, number>();
const lastAgentSnapshot = new Map<string, number>();
const disconnectedSince = new Map<string, number>();
const SNAPSHOT_EVERY_MS = 5 * 60_000;

function dealReasonToExit(reason: string | undefined, initiatedBy: string | null): "sl" | "tp" | "agent" | "kill_switch" | "manual" | "stop_out" | "unknown" {
  switch (reason) {
    case "DEAL_REASON_SL": return "sl";
    case "DEAL_REASON_TP": return "tp";
    case "DEAL_REASON_SO": return "stop_out";
    case "DEAL_REASON_EXPERT":
      if (initiatedBy === "kill_switch") return "kill_switch";
      if (initiatedBy === "manual") return "manual";
      return "agent";
    case "DEAL_REASON_CLIENT": case "DEAL_REASON_MOBILE": case "DEAL_REASON_WEB": return "manual";
    default: return "unknown";
  }
}

/** Heartbeat: MetaApi state + broker connection + latency. Runs every minute per deployed account. */
export async function heartbeat(ctx: Ctx, mt: MetaApiManager): Promise<void> {
  if (!(await mt.configured())) return;
  const accounts = await ctx.sql<AccountRow[]>`
    select id, name, metaapi_account_id, server, status, account_type from mt_accounts
    where metaapi_account_id is not null and status not in ('undeployed','archived','pending')`;
  for (const acc of accounts) {
    let state: string | null = null, brokerConnected = false, latency: number | null = null, serverTime: Date | null = null, error: string | null = null;
    try {
      const account = await mt.getAccount(acc.metaapi_account_id);
      state = account.state as string;
      brokerConnected = state === "DEPLOYED" && account.connectionStatus === "CONNECTED";
      if (brokerConnected) {
        const t0 = Date.now();
        serverTime = new Date((await mt.serverTime(acc.metaapi_account_id)).time);
        latency = Date.now() - t0;
      }
    } catch (err) {
      error = (err as Error).message;
      brokerConnected = false;
    }
    await ctx.sql`
      insert into connection_heartbeats (mt_account_id, metaapi_state, broker_connected, latency_ms, server_time, error)
      values (${acc.id}, ${state}, ${brokerConnected}, ${latency}, ${serverTime}, ${error})`;

    const newStatus = brokerConnected ? "connected" : state === "DEPLOYING" ? "deploying" : error ? "error" : "disconnected";
    if (newStatus !== acc.status) {
      await ctx.sql`update mt_accounts set status = ${newStatus}, last_error = ${error} where id = ${acc.id}`;
    }
    if (brokerConnected) {
      if (disconnectedSince.has(acc.id)) {
        disconnectedSince.delete(acc.id);
        await systemEvent(ctx, "info", "heartbeat", "account_reconnected", `${acc.name}: połączenie przywrócone`, { mtAccountId: acc.id });
      }
    } else if (!disconnectedSince.has(acc.id)) {
      disconnectedSince.set(acc.id, Date.now());
    } else if (Date.now() - disconnectedSince.get(acc.id)! > 5 * 60_000 && Date.now() - disconnectedSince.get(acc.id)! < 6 * 60_000) {
      await systemEvent(ctx, "error", "heartbeat", "account_disconnected",
        `${acc.name}: brak połączenia z brokerem od ponad 5 min (${state ?? "?"}${error ? `, ${error}` : ""})`, { mtAccountId: acc.id });
    }
  }
}

/**
 * Full reconciliation for one account: account snapshot, positions -> trades,
 * deals -> realized P&L, closures, MAE/MFE, agent equity snapshots and kill switch.
 */
export async function syncAccount(ctx: Ctx, mt: MetaApiManager, acc: AccountRow): Promise<void> {
  const id = acc.metaapi_account_id;
  const info = await mt.accountInformation(id);
  const brokerType = info.type === "ACCOUNT_TRADE_MODE_REAL" ? "real" : "demo";
  await ctx.sql`
    update mt_accounts set currency = ${info.currency}, leverage = ${info.leverage}, margin_mode = ${info.marginMode},
           account_type = ${brokerType}
    where id = ${acc.id} and (currency is distinct from ${info.currency} or leverage is distinct from ${info.leverage}
           or margin_mode is distinct from ${info.marginMode} or account_type is distinct from ${brokerType})`;
  if (brokerType === "real" && acc.account_type !== "real") {
    await systemEvent(ctx, "critical", "sync", "real_account_detected", `${acc.name} to konto REALNE — handel na nim jest zablokowany.`, { mtAccountId: acc.id });
  }

  const now = Date.now();
  if (now - (lastSnapshot.get(acc.id) ?? 0) >= SNAPSHOT_EVERY_MS) {
    await ctx.sql`
      insert into account_snapshots (mt_account_id, balance, equity, margin, free_margin, margin_level, currency)
      values (${acc.id}, ${info.balance}, ${info.equity}, ${info.margin}, ${info.freeMargin}, ${info.marginLevel ?? null}, ${info.currency})`;
    lastSnapshot.set(acc.id, now);
  }

  const agents = await ctx.sql<AgentRow[]>`select id, code, magic, status, max_drawdown_pct, name from agents where mt_account_id = ${acc.id}`;
  const byMagic = new Map(agents.map((a) => [a.magic, a]));
  const positions = await mt.positions(id);
  const openTrades = await ctx.sql<OpenTradeRow[]>`
    select id, agent_id, position_id, symbol, direction, volume_open, current_sl, current_tp, entry_price, risk_amount,
           opened_at, mae_price, mfe_price, open_decision_id
    from trades where mt_account_id = ${acc.id} and status = 'open'`;
  const tradeByPos = new Map(openTrades.map((t) => [t.position_id, t]));
  const seen = new Set<string>();

  for (const p of positions) {
    seen.add(p.id);
    const agent = byMagic.get(p.magic);
    if (!agent) {
      await flagIssue(ctx, acc.id, "unknown_position", p.id, { symbol: p.symbol, magic: p.magic, volume: p.volume, clientId: p.clientId ?? null },
        `${acc.name}: pozycja ${p.symbol} #${p.id} (magic ${p.magic}) nie należy do żadnego agenta — otwarta ręcznie lub przez inny system.`);
      continue;
    }
    let trade = tradeByPos.get(p.id);
    if (!trade) trade = await adoptPosition(ctx, mt, acc, agent, p);
    if (!trade) continue;
    await reconcileOpen(ctx, acc, trade, p);
  }

  // Positions we track as open that the broker no longer has -> closed.
  for (const t of openTrades) {
    if (!seen.has(t.position_id)) await bookClosure(ctx, mt, acc, t);
  }

  // Book partial-close/commission deals of still-open trades from the last 20 minutes.
  const stillOpen = openTrades.filter((t) => seen.has(t.position_id));
  if (stillOpen.length) {
    const deals = await mt.dealsByTimeRange(id, new Date(now - 20 * 60_000), new Date(now + 60_000));
    for (const t of stillOpen) await applyDeals(ctx, t, deals.filter((d) => d.positionId === t.position_id));
  }

  // Periodic spread samples for every instrument an active agent trades on this account.
  const symbols = await ctx.sql<{ symbol: string }[]>`
    select distinct unnest(instruments) as symbol from agents where mt_account_id = ${acc.id} and status = 'active'`;
  for (const { symbol } of symbols) {
    if (now - (lastSnapshot.get(`spread:${acc.id}:${symbol}`) ?? 0) < 15 * 60_000) continue;
    try {
      const spec = await getSpec(ctx, mt, acc, symbol);
      const q = await mt.symbolPrice(id, symbol);
      await recordSpread(ctx, acc.server, symbol, q.bid, q.ask, spec.point, "periodic");
      lastSnapshot.set(`spread:${acc.id}:${symbol}`, now);
    } catch (err) {
      ctx.log.debug({ err, symbol }, "spread sample failed");
    }
  }

  await agentEquityAndKill(ctx, mt, acc, agents);
}

async function adoptPosition(ctx: Ctx, mt: MetaApiManager, acc: AccountRow, agent: AgentRow, p: Position): Promise<OpenTradeRow | undefined> {
  // Match to our order via clientId to recover the decision that opened it.
  const [order] = p.clientId
    ? await ctx.sql<{ id: string; decision_id: string | null; requested_price: number | null }[]>`
        select id, decision_id, requested_price from orders where client_id = ${p.clientId} and agent_id = ${agent.id}`
    : [];
  const [planned] = order?.decision_id
    ? await ctx.sql<{ risk: number | null }[]>`select (risk_check->'sizing'->>'riskAmount')::numeric as risk from decisions where id = ${order.decision_id}`
    : [];
  const spec = await getSpec(ctx, mt, acc, p.symbol);
  const direction = p.type === "POSITION_TYPE_BUY" ? "long" : "short";
  await recordOpenedTrade(ctx, mt, acc, agent.id, order?.decision_id ?? null, spec, {
    positionId: p.id, symbol: p.symbol, direction, volume: p.volume, entry: p.openPrice,
    requestedEntry: order?.requested_price ?? null, sl: p.stopLoss ?? null, tp: p.takeProfit ?? null,
    openedAt: new Date(p.time), fallbackRisk: planned?.risk ?? 0, riskPctBase: null, orderId: order?.id ?? null,
  });
  if (!order) {
    await flagIssue(ctx, acc.id, "unknown_position", p.id, { symbol: p.symbol, magic: p.magic, clientId: p.clientId ?? null },
      `${acc.name}: pozycja #${p.id} ma magic agenta ${agent.code}, ale nie pochodzi z zarejestrowanego zlecenia.`);
  }
  const [t] = await ctx.sql<OpenTradeRow[]>`
    select id, agent_id, position_id, symbol, direction, volume_open, current_sl, current_tp, entry_price, risk_amount,
           opened_at, mae_price, mfe_price, open_decision_id
    from trades where mt_account_id = ${acc.id} and position_id = ${p.id}`;
  return t;
}

async function reconcileOpen(ctx: Ctx, acc: AccountRow, t: OpenTradeRow, p: Position): Promise<void> {
  const sl = p.stopLoss ?? null, tp = p.takeProfit ?? null;
  const changed = !near(sl, t.current_sl) || !near(tp, t.current_tp);
  if (changed) {
    // Was the change made by us in the last 3 minutes?
    const [ours] = await ctx.sql`
      select 1 from orders where mt_account_id = ${acc.id} and position_id = ${t.position_id}
        and order_kind = 'modify' and status = 'accepted' and created_at > now() - interval '3 minutes'`;
    if (!ours) {
      await ctx.sql`insert into position_events (trade_id, kind, old_value, new_value)
                    values (${t.id}, 'external_change', ${ctx.sql.json({ sl: t.current_sl, tp: t.current_tp } as never)},
                            ${ctx.sql.json({ sl, tp } as never)})`;
      await flagIssue(ctx, acc.id, "external_modification", t.position_id, { from: { sl: t.current_sl, tp: t.current_tp }, to: { sl, tp } },
        `${acc.name}: SL/TP pozycji ${t.symbol} #${t.position_id} zmienione poza systemem (${t.current_sl}/${t.current_tp} → ${sl}/${tp}).`);
    }
  }
  const adverse = t.direction === "long" ? Math.min(t.mae_price ?? p.currentPrice, p.currentPrice) : Math.max(t.mae_price ?? p.currentPrice, p.currentPrice);
  const favorable = t.direction === "long" ? Math.max(t.mfe_price ?? p.currentPrice, p.currentPrice) : Math.min(t.mfe_price ?? p.currentPrice, p.currentPrice);
  await ctx.sql`
    update trades set current_sl = ${sl}, current_tp = ${tp}, volume_open = ${p.volume},
           unrealized_pnl = ${Math.round((p.unrealizedProfit ?? p.profit) * 100) / 100},
           mae_price = ${adverse}, mfe_price = ${favorable}
    where id = ${t.id}`;
}

function near(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
}

/** Inserts deal events (idempotent by deal_id) and recomputes realized totals from all recorded deals. */
async function applyDeals(ctx: Ctx, t: OpenTradeRow, deals: Deal[]): Promise<void> {
  for (const d of deals) {
    const kind = d.entryType === "DEAL_ENTRY_IN" ? (d.time.getTime() - t.opened_at.getTime() < 5000 ? "open" : "add") : "partial_close";
    if (kind === "open") {
      // The open event exists already; store the entry deal's commission on a deal-keyed row only once.
      await ctx.sql`
        insert into position_events (trade_id, kind, volume, price, pnl, deal_id, new_value)
        values (${t.id}, 'open', ${d.volume ?? null}, ${d.price ?? null}, ${(d.commission ?? 0) + (d.swap ?? 0) + d.profit},
                ${d.id}, ${ctx.sql.json({ profit: d.profit, commission: d.commission ?? 0, swap: d.swap ?? 0, deal: true } as never)})
        on conflict (trade_id, deal_id) where deal_id is not null do nothing`;
    } else {
      await ctx.sql`
        insert into position_events (trade_id, kind, volume, price, pnl, deal_id, new_value)
        values (${t.id}, ${kind}, ${d.volume ?? null}, ${d.price ?? null}, ${(d.commission ?? 0) + (d.swap ?? 0) + d.profit},
                ${d.id}, ${ctx.sql.json({ profit: d.profit, commission: d.commission ?? 0, swap: d.swap ?? 0, reason: d.reason ?? null } as never)})
        on conflict (trade_id, deal_id) where deal_id is not null do nothing`;
    }
  }
  await ctx.sql`
    update trades t set
      realized_gross_pnl = coalesce(s.profit, 0), commission = coalesce(s.commission, 0), swap = coalesce(s.swap, 0)
    from (
      select sum((new_value->>'profit')::numeric) as profit, sum((new_value->>'commission')::numeric) as commission,
             sum((new_value->>'swap')::numeric) as swap
      from position_events where trade_id = ${t.id} and deal_id is not null
    ) s
    where t.id = ${t.id}`;
}

async function bookClosure(ctx: Ctx, mt: MetaApiManager, acc: AccountRow, t: OpenTradeRow): Promise<void> {
  const deals = (await mt.dealsByTimeRange(acc.metaapi_account_id, new Date(t.opened_at.getTime() - 60_000), new Date(Date.now() + 60_000)))
    .filter((d) => d.positionId === t.position_id);
  const outs = deals.filter((d) => d.entryType === "DEAL_ENTRY_OUT" || d.entryType === "DEAL_ENTRY_OUT_BY" || d.entryType === "DEAL_ENTRY_INOUT");
  if (outs.length === 0) {
    // Broker history can lag a few seconds behind; try again on the next sync, but flag if it persists.
    const [age] = await ctx.sql<{ n: number }[]>`select count(*)::int as n from reconciliation_issues where mt_account_id = ${acc.id}
                     and kind = 'missing_position' and position_id = ${t.position_id} and resolved_at is null`;
    if (!age?.n) {
      await flagIssue(ctx, acc.id, "missing_position", t.position_id, { symbol: t.symbol },
        `${acc.name}: pozycja ${t.symbol} #${t.position_id} zniknęła, ale brak jeszcze transakcji zamknięcia w historii.`, false);
    }
    return;
  }
  await applyDeals(ctx, t, deals);
  const last = outs.reduce((a, b) => (new Date(a.time) > new Date(b.time) ? a : b));
  const [order] = last.clientId
    ? await ctx.sql<{ initiated_by: string }[]>`select initiated_by from orders where client_id = ${last.clientId}`
    : [];
  const exitReason = dealReasonToExit(last.reason, order?.initiated_by ?? null);

  const [closed] = await ctx.sql<{ net_pnl: number; r_multiple: number; agent_id: string; symbol: string; direction: string }[]>`
    update trades set status = 'closed', closed_at = ${new Date(last.time)}, exit_price = ${last.price ?? null},
           exit_reason = ${exitReason}, volume_open = 0, unrealized_pnl = 0,
           r_multiple = round((realized_gross_pnl + commission + swap) / risk_amount, 4)
    where id = ${t.id} and status = 'open'
    returning net_pnl, r_multiple, agent_id, symbol, direction`;
  if (!closed) return;
  await ctx.sql`update reconciliation_issues set resolved_at = now(), resolution = 'closing deal found'
                where mt_account_id = ${acc.id} and position_id = ${t.position_id} and kind = 'missing_position' and resolved_at is null`;
  if (t.open_decision_id) {
    await ctx.sql`update decisions set outcome_r = ${closed.r_multiple}, outcome_hit = ${closed.net_pnl > 0}, outcome_at = now()
                  where id = ${t.open_decision_id}`;
  }
  await ctx.sql`insert into commands (kind, payload) values ('review_trade', ${ctx.sql.json({ trade_id: t.id } as never)})`.catch(() => undefined);

  const tg = await getSetting(ctx, "telegram");
  if (tg.notify_trades) {
    const [a] = await ctx.sql<{ code: string; name: string }[]>`select code, name from agents where id = ${closed.agent_id}`;
    await notify(ctx, `${closed.net_pnl >= 0 ? "✅" : "🔻"} <b>${escapeHtml(a?.code ?? "")}</b> zamknął ${closed.direction} ${escapeHtml(closed.symbol)}: ` +
      `${closed.net_pnl.toFixed(2)} (${closed.r_multiple.toFixed(2)}R), powód: ${exitReason}`).catch(() => undefined);
  }
}

async function flagIssue(ctx: Ctx, accId: string, kind: string, positionId: string, details: Record<string, unknown>, message: string, alert = true): Promise<void> {
  const res = await ctx.sql`
    insert into reconciliation_issues (mt_account_id, kind, position_id, details)
    values (${accId}, ${kind}, ${positionId}, ${ctx.sql.json(details as never)})
    on conflict (mt_account_id, kind, position_id) where resolved_at is null do nothing
    returning id`;
  if (res.length && alert) await systemEvent(ctx, "warn", "sync", kind, message, { mtAccountId: accId, context: details });
}

/** Per-agent virtual equity snapshot and drawdown kill switch. */
async function agentEquityAndKill(ctx: Ctx, mt: MetaApiManager, acc: AccountRow, agents: AgentRow[]): Promise<void> {
  const now = Date.now();
  for (const a of agents) {
    if (a.status === "archived" || a.status === "draft") continue;
    if (now - (lastAgentSnapshot.get(a.id) ?? 0) < SNAPSHOT_EVERY_MS) continue;
    const [e] = await ctx.sql<{ equity: number; realized_pnl: number; unrealized_pnl: number; open_positions: number }[]>`
      select equity, realized_pnl, unrealized_pnl, open_positions from v_agent_equity where agent_id = ${a.id}`;
    if (!e) continue;
    const open = await ctx.sql<{ symbol: string; direction: "long" | "short"; entry_price: number; current_sl: number | null; volume_open: number; risk_amount: number }[]>`
      select symbol, direction, entry_price, current_sl, volume_open, risk_amount from trades where agent_id = ${a.id} and status = 'open'`;
    let openRisk = 0;
    for (const t of open) {
      try {
        const spec = await getSpec(ctx, mt, acc, t.symbol);
        const q = await mt.symbolPrice(acc.metaapi_account_id, t.symbol);
        openRisk += openPositionRisk(t.direction, t.entry_price, t.current_sl, t.volume_open, spec, q.lossTickValue, t.risk_amount);
      } catch { openRisk += t.risk_amount; }
    }
    await ctx.sql`
      insert into agent_equity_snapshots (agent_id, equity, realized_pnl, unrealized_pnl, open_risk, open_positions)
      values (${a.id}, ${e.equity}, ${e.realized_pnl}, ${e.unrealized_pnl}, ${Math.round(openRisk * 100) / 100}, ${e.open_positions})`;
    lastAgentSnapshot.set(a.id, now);

    if (a.status !== "active" && a.status !== "paused") continue;
    const [peak] = await ctx.sql<{ peak: number }[]>`select max(equity) as peak from agent_equity_snapshots where agent_id = ${a.id}`;
    const dd = peak && peak.peak > 0 ? ((peak.peak - e.equity) / peak.peak) * 100 : 0;
    if (dd >= a.max_drawdown_pct) {
      await ctx.sql`update agents set status = 'killed', status_reason = ${`kill switch: drawdown ${dd.toFixed(2)}% >= ${a.max_drawdown_pct}%`} where id = ${a.id}`;
      const res = await closeAllForAgent(ctx, mt, a.id, "kill_switch");
      await systemEvent(ctx, "critical", "risk", "kill_switch",
        `Agent ${a.code} (${a.name}) zatrzymany: obsunięcie ${dd.toFixed(2)}% ≥ ${a.max_drawdown_pct}%. Zamknięto ${res.closed} poz.` +
        (res.failed.length ? ` Błędy: ${res.failed.join("; ")}` : ""), { agentId: a.id, mtAccountId: acc.id, telegram: true });
    }
  }
}

/** Runs syncAccount for all connected accounts. */
export async function syncAll(ctx: Ctx, mt: MetaApiManager): Promise<void> {
  if (!(await mt.configured())) return;
  const accounts = await ctx.sql<AccountRow[]>`
    select id, name, metaapi_account_id, server, status, account_type from mt_accounts
    where metaapi_account_id is not null and status = 'connected'`;
  for (const acc of accounts) {
    try {
      await syncAccount(ctx, mt, acc);
      await ctx.sql`update data_sources set last_success_at = now() where code = 'metaapi'`;
    } catch (err) {
      await ctx.sql`update data_sources set last_error_at = now(), last_error = ${(err as Error).message} where code = 'metaapi'`;
      ctx.log.warn({ err, account: acc.name }, "account sync failed");
    }
  }
}
