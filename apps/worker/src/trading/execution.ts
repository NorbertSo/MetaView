import { randomBytes } from "node:crypto";
import { floorToStep, openPositionRisk, type SymbolSpec } from "@tv/core";
import type { Ctx } from "../context.js";
import { systemEvent } from "../events.js";
import { TradeRejected, type MetaApiManager } from "../metaapi/manager.js";
import { getSpec, type AccountRef } from "../metaapi/instruments.js";

export type Initiator = "agent" | "kill_switch" | "manual" | "system";

export interface AgentRef { id: string; code: string; magic: number }

/** clientId: agent code + random suffix; MetaApi limits comment+clientId to 26 chars. */
export function newClientId(agentCode: string): string {
  return `${agentCode}-${randomBytes(6).toString("hex")}`; // e.g. "A01-9f3c2a1b7d4e" (16 chars)
}

interface OrderInsert {
  decisionId: string | null; agent: AgentRef | null; acc: AccountRef; clientId: string; symbol: string;
  side: "buy" | "sell" | null; kind: "market" | "modify" | "close" | "close_partial"; volume: number | null;
  requestedPrice: number | null; sl: number | null; tp: number | null; positionId: string | null; initiatedBy: Initiator;
}

async function insertOrder(ctx: Ctx, o: OrderInsert): Promise<string> {
  const [row] = await ctx.sql<{ id: string }[]>`
    insert into orders (decision_id, agent_id, mt_account_id, client_id, magic, symbol, side, order_kind, volume,
                        requested_price, stop_loss, take_profit, position_id, initiated_by)
    values (${o.decisionId}, ${o.agent?.id ?? null}, ${o.acc.id}, ${o.clientId}, ${o.agent?.magic ?? null}, ${o.symbol},
            ${o.side}, ${o.kind}, ${o.volume}, ${o.requestedPrice}, ${o.sl}, ${o.tp}, ${o.positionId}, ${o.initiatedBy})
    returning id`;
  return row!.id;
}

async function finishOrder(ctx: Ctx, orderId: string, started: number, res: { ok: true; orderId: string; positionId: string; code: string } | { ok: false; code: string; error: string }) {
  await ctx.sql`
    update orders set
      status = ${res.ok ? "accepted" : res.code === "EXCEPTION" ? "error" : "rejected"},
      broker_order_id = ${res.ok ? res.orderId : null},
      position_id = coalesce(${res.ok ? res.positionId || null : null}, position_id),
      retcode = ${res.code}, error = ${res.ok ? null : res.error},
      acked_at = now(), latency_ms = ${Date.now() - started}
    where id = ${orderId}`;
}

function failure(err: unknown): { ok: false; code: string; error: string } {
  if (err instanceof TradeRejected) return { ok: false, code: err.code, error: err.message };
  return { ok: false, code: "EXCEPTION", error: (err as Error).message };
}

export interface OpenRequest {
  acc: AccountRef; agent: AgentRef; decisionId: string; symbol: string; direction: "long" | "short";
  volume: number; requestedPrice: number; sl: number; tp: number | null; plannedRisk: number; riskPct: number;
}

/**
 * Sends a market order and records the resulting trade. The trade row is also
 * created by the sync loop if this process dies between the broker ack and the insert.
 */
export async function openPosition(ctx: Ctx, mt: MetaApiManager, r: OpenRequest): Promise<{ ok: boolean; tradeId?: string; error?: string }> {
  const clientId = newClientId(r.agent.code);
  const side = r.direction === "long" ? "buy" : "sell";
  const orderId = await insertOrder(ctx, {
    decisionId: r.decisionId, agent: r.agent, acc: r.acc, clientId, symbol: r.symbol, side, kind: "market",
    volume: r.volume, requestedPrice: r.requestedPrice, sl: r.sl, tp: r.tp, positionId: null, initiatedBy: "agent",
  });
  const started = Date.now();
  let res;
  try {
    res = await mt.marketOrder(r.acc.metaapi_account_id, side, r.symbol, r.volume, r.sl, r.tp, { clientId, magic: r.agent.magic });
  } catch (err) {
    const f = failure(err);
    await finishOrder(ctx, orderId, started, f);
    return { ok: false, error: f.error };
  }
  await finishOrder(ctx, orderId, started, { ok: true, orderId: res.orderId, positionId: res.positionId, code: res.stringCode });

  // Fetch the actual fill to record the real entry price and risk.
  const positions = await mt.positions(r.acc.metaapi_account_id).catch(() => []);
  const pos = positions.find((p) => p.id === String(res.positionId)) ?? positions.find((p) => p.clientId === clientId);
  if (!pos) {
    await systemEvent(ctx, "warn", "execution", "fill_not_found",
      `Order ${clientId} accepted but position not visible yet; sync will record it`, { agentId: r.agent.id, mtAccountId: r.acc.id });
    return { ok: true };
  }
  const spec = await getSpec(ctx, mt, r.acc, r.symbol);
  const tradeId = await recordOpenedTrade(ctx, mt, r.acc, r.agent.id, r.decisionId, spec, {
    positionId: pos.id, symbol: pos.symbol, direction: r.direction, volume: pos.volume, entry: pos.openPrice,
    requestedEntry: r.requestedPrice, sl: pos.stopLoss ?? r.sl, tp: pos.takeProfit ?? r.tp, openedAt: new Date(pos.time),
    fallbackRisk: r.plannedRisk, riskPctBase: r.riskPct, orderId,
  });
  return { ok: true, tradeId };
}

export interface OpenedTrade {
  positionId: string; symbol: string; direction: "long" | "short"; volume: number; entry: number; requestedEntry: number | null;
  sl: number | null; tp: number | null; openedAt: Date; fallbackRisk: number; riskPctBase: number | null; orderId: string | null;
}

/** Idempotently inserts the trade row (+ open event) for a broker position. */
export async function recordOpenedTrade(ctx: Ctx, mt: MetaApiManager, acc: AccountRef, agentId: string, decisionId: string | null,
  spec: SymbolSpec, t: OpenedTrade): Promise<string> {
  let risk = t.fallbackRisk;
  if (t.sl !== null) {
    const price = await mt.symbolPrice(acc.metaapi_account_id, t.symbol).catch(() => null);
    if (price) risk = openPositionRisk(t.direction, t.entry, t.sl, t.volume, spec, price.lossTickValue, t.fallbackRisk);
  }
  if (!(risk > 0)) risk = Math.max(t.fallbackRisk, 0.01); // a trade must have a positive 1R to compute R multiples
  const [agent] = await ctx.sql<{ equity: number }[]>`select equity from v_agent_equity where agent_id = ${agentId}`;
  const riskPct = agent && agent.equity > 0 ? (risk / agent.equity) * 100 : (t.riskPctBase ?? 0);
  const slippage = t.requestedEntry !== null ? Math.round(((t.direction === "long" ? t.entry - t.requestedEntry : t.requestedEntry - t.entry) / spec.point) * 100) / 100 : null;

  const [row] = await ctx.sql<{ id: string; inserted: boolean }[]>`
    insert into trades (agent_id, mt_account_id, open_decision_id, position_id, symbol, direction, volume_initial, volume_open,
                        requested_entry_price, entry_price, slippage_points, initial_sl, initial_tp, current_sl, current_tp,
                        risk_amount, risk_pct, opened_at, mae_price, mfe_price)
    values (${agentId}, ${acc.id}, ${decisionId}, ${t.positionId}, ${t.symbol}, ${t.direction}, ${t.volume}, ${t.volume},
            ${t.requestedEntry}, ${t.entry}, ${slippage}, ${t.sl ?? t.entry}, ${t.tp}, ${t.sl}, ${t.tp},
            ${Math.round(risk * 100) / 100}, ${Math.round(riskPct * 1000) / 1000}, ${t.openedAt}, ${t.entry}, ${t.entry})
    on conflict (mt_account_id, position_id) do update set updated_at = trades.updated_at
    returning id, (xmax = 0) as inserted`;
  if (row!.inserted) {
    await ctx.sql`
      insert into position_events (trade_id, decision_id, order_id, kind, new_value, volume, price)
      values (${row!.id}, ${decisionId}, ${t.orderId}, 'open',
              ${ctx.sql.json({ sl: t.sl, tp: t.tp } as never)}, ${t.volume}, ${t.entry})`;
  }
  return row!.id;
}

export interface TradeRow {
  id: string; agent_id: string; position_id: string; symbol: string; direction: "long" | "short";
  volume_open: number; current_sl: number | null; current_tp: number | null;
}

export async function modifyTrade(ctx: Ctx, mt: MetaApiManager, acc: AccountRef, agent: AgentRef, decisionId: string | null,
  trade: TradeRow, sl: number | null, tp: number | null, initiatedBy: Initiator): Promise<{ ok: boolean; error?: string }> {
  const newSl = sl ?? trade.current_sl;
  const newTp = tp ?? trade.current_tp;
  const orderId = await insertOrder(ctx, {
    decisionId, agent, acc, clientId: newClientId(agent.code), symbol: trade.symbol, side: null, kind: "modify",
    volume: null, requestedPrice: null, sl: newSl, tp: newTp, positionId: trade.position_id, initiatedBy,
  });
  const started = Date.now();
  try {
    const res = await mt.modifyPosition(acc.metaapi_account_id, trade.position_id, newSl ?? undefined, newTp ?? undefined);
    await finishOrder(ctx, orderId, started, { ok: true, orderId: res.orderId, positionId: trade.position_id, code: res.stringCode });
  } catch (err) {
    const f = failure(err);
    await finishOrder(ctx, orderId, started, f);
    return { ok: false, error: f.error };
  }
  await ctx.sql.begin(async (tx) => {
    await tx`update trades set current_sl = ${newSl}, current_tp = ${newTp} where id = ${trade.id}`;
    if (sl !== null && sl !== trade.current_sl) {
      await tx`insert into position_events (trade_id, decision_id, order_id, kind, old_value, new_value)
               values (${trade.id}, ${decisionId}, ${orderId}, 'modify_sl', ${tx.json({ sl: trade.current_sl } as never)}, ${tx.json({ sl } as never)})`;
    }
    if (tp !== null && tp !== trade.current_tp) {
      await tx`insert into position_events (trade_id, decision_id, order_id, kind, old_value, new_value)
               values (${trade.id}, ${decisionId}, ${orderId}, 'modify_tp', ${tx.json({ tp: trade.current_tp } as never)}, ${tx.json({ tp } as never)})`;
    }
  });
  return { ok: true };
}

/**
 * Closes a position fully, or partially when fraction < 1. A partial close that
 * would leave less than the minimum volume is turned into a full close; one that
 * is itself below the minimum is rejected.
 */
export async function closeTrade(ctx: Ctx, mt: MetaApiManager, acc: AccountRef, agent: AgentRef, decisionId: string | null,
  trade: TradeRow, fraction: number, initiatedBy: Initiator): Promise<{ ok: boolean; error?: string; volume?: number }> {
  const spec = await getSpec(ctx, mt, acc, trade.symbol);
  let volume = trade.volume_open;
  let kind: "close" | "close_partial" = "close";
  if (fraction < 1) {
    const part = floorToStep(trade.volume_open * fraction, spec.volumeStep);
    const remainder = floorToStep(trade.volume_open - part, spec.volumeStep);
    if (part < spec.volumeMin) return { ok: false, error: `partial volume ${part} below broker minimum ${spec.volumeMin}` };
    if (remainder >= spec.volumeMin) { volume = part; kind = "close_partial"; }
  }
  const clientId = newClientId(agent.code);
  const orderId = await insertOrder(ctx, {
    decisionId, agent, acc, clientId, symbol: trade.symbol, side: trade.direction === "long" ? "sell" : "buy", kind,
    volume, requestedPrice: null, sl: null, tp: null, positionId: trade.position_id, initiatedBy,
  });
  const started = Date.now();
  try {
    const res = kind === "close"
      ? await mt.closePosition(acc.metaapi_account_id, trade.position_id, { clientId, magic: agent.magic })
      : await mt.closePositionPartially(acc.metaapi_account_id, trade.position_id, volume, { clientId, magic: agent.magic });
    await finishOrder(ctx, orderId, started, { ok: true, orderId: res.orderId, positionId: trade.position_id, code: res.stringCode });
    return { ok: true, volume };
  } catch (err) {
    const f = failure(err);
    await finishOrder(ctx, orderId, started, f);
    return { ok: false, error: f.error };
  }
}

/** Closes every open position of an agent (kill switch / manual). Realized P&L is booked by the sync loop. */
export async function closeAllForAgent(ctx: Ctx, mt: MetaApiManager, agentId: string, initiatedBy: Initiator): Promise<{ closed: number; failed: string[] }> {
  const rows = await ctx.sql<(TradeRow & { code: string; magic: number; acc_id: string; metaapi_account_id: string; server: string })[]>`
    select t.id, t.agent_id, t.position_id, t.symbol, t.direction, t.volume_open, t.current_sl, t.current_tp,
           a.code, a.magic, m.id as acc_id, m.metaapi_account_id, m.server
    from trades t join agents a on a.id = t.agent_id join mt_accounts m on m.id = t.mt_account_id
    where t.agent_id = ${agentId} and t.status = 'open'`;
  let closed = 0;
  const failed: string[] = [];
  for (const t of rows) {
    const res = await closeTrade(ctx, mt, { id: t.acc_id, metaapi_account_id: t.metaapi_account_id, server: t.server },
      { id: agentId, code: t.code, magic: t.magic }, null, t, 1, initiatedBy);
    if (res.ok) closed++; else failed.push(`${t.symbol} #${t.position_id}: ${res.error}`);
  }
  return { closed, failed };
}
