import {
  evaluateRisk, ModelDecisionBatch, openPositionRisk, submitDecisionsJsonSchema, symbolCurrencies,
  type Intent, type ModelDecision, type OpenPositionRisk, type RiskContext, type RiskEvaluation,
} from "@tv/core";
import type { Ctx } from "../context.js";
import { systemEvent, escapeHtml } from "../events.js";
import { callModel, LlmError } from "../llm/client.js";
import type { MetaApiManager } from "../metaapi/manager.js";
import { getSpec, medianSpread, type AccountRef } from "../metaapi/instruments.js";
import { getSetting } from "../settings.js";
import { notify } from "../telegram.js";
import { closeTrade, modifyTrade, openPosition, type AgentRef, type TradeRow } from "../trading/execution.js";
import { buildContext, loadAgent, type AgentFull, type BuiltContext } from "./context-builder.js";
import { buildSystemPrompt, PROTOCOL_VERSION } from "./prompt.js";

export type RunTrigger = "schedule" | "event" | "manual" | "position_check";

/**
 * One agent run: context -> model -> validation -> risk gates -> execution.
 * Every decision is persisted, including rejected and no-op ones.
 */
export async function runAgent(ctx: Ctx, mt: MetaApiManager, agentId: string, trigger: RunTrigger, triggerRef: string | null = null): Promise<{ runId: string | null; status: string }> {
  const a = await loadAgent(ctx, agentId);
  if (!a) throw new Error(`agent ${agentId} not found`);

  let runId: string;
  try {
    const [run] = await ctx.sql<{ id: string }[]>`insert into agent_runs (agent_id, trigger, trigger_ref) values (${a.id}, ${trigger}, ${triggerRef}) returning id`;
    runId = run!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { runId: null, status: "already_running" };
    throw err;
  }

  const finish = async (status: "ok" | "error" | "skipped", extra: { skip?: string; error?: string; llmCallId?: string | null } = {}) => {
    await ctx.sql`update agent_runs set status = ${status}, finished_at = now(), skip_reason = ${extra.skip ?? null},
                  error = ${extra.error ?? null}, llm_call_id = coalesce(${extra.llmCallId ?? null}, llm_call_id) where id = ${runId}`;
  };

  try {
    const pre = preflight(a);
    if (pre) { await finish("skipped", { skip: pre }); return { runId, status: "skipped" }; }
    if (!(await getSetting(ctx, "trading_enabled"))) {
      // With trading off we still let agents manage open positions (risk-reducing actions pass the gates).
      const [open] = await ctx.sql<{ n: number }[]>`select count(*)::int as n from trades where agent_id = ${a.id} and status = 'open'`;
      if (!open?.n) { await finish("skipped", { skip: "global trading switch is off" }); return { runId, status: "skipped" }; }
    }

    const built = await buildContext(ctx, mt, a);
    const system = buildSystemPrompt(a.rules_md, a.system_prompt);
    let result;
    try {
      result = await callModel(ctx, {
        modelId: a.model_id, purpose: "decision", agentId: a.id, system,
        user: `CONTEXT (${PROTOCOL_VERSION}):\n${JSON.stringify(built.json)}`,
        tool: { name: "submit_decisions", description: "Submit your decisions for this run.", inputSchema: submitDecisionsJsonSchema as unknown as Record<string, unknown> },
        temperature: a.temperature,
      });
    } catch (err) {
      const callId = err instanceof LlmError ? err.callId : null;
      await finish("error", { error: (err as Error).message, llmCallId: callId });
      await systemEvent(ctx, "error", "agent", "llm_failed", `${a.code}: ${(err as Error).message}`, { agentId: a.id });
      return { runId, status: "error" };
    }

    const parsed = ModelDecisionBatch.safeParse(result.toolInput);
    if (!parsed.success) {
      await ctx.sql`update llm_calls set status = 'invalid_output', error = ${parsed.error.message.slice(0, 2000)} where id = ${result.callId}`;
      await finish("error", { error: `invalid model output: ${parsed.error.issues.map((i) => i.message).join("; ")}`, llmCallId: result.callId });
      await systemEvent(ctx, "warn", "agent", "invalid_output", `${a.code}: model output failed validation`, { agentId: a.id });
      return { runId, status: "error" };
    }

    for (const d of parsed.data.decisions) {
      await handleDecision(ctx, mt, a, runId, built, d, parsed.data.market_view, result.callId).catch(async (err) => {
        await systemEvent(ctx, "error", "agent", "decision_failed", `${a.code}: ${(err as Error).message}`, { agentId: a.id });
      });
    }
    await finish("ok", { llmCallId: result.callId });
    return { runId, status: "ok" };
  } catch (err) {
    await finish("error", { error: (err as Error).message });
    await systemEvent(ctx, "error", "agent", "run_failed", `${a.code}: ${(err as Error).message}`, { agentId: a.id });
    return { runId, status: "error" };
  }
}

function preflight(a: AgentFull): string | null {
  if (a.status !== "active") return `agent status is ${a.status}`;
  if (a.account_status !== "connected") return `account is ${a.account_status}`;
  return null;
}

async function riskContext(ctx: Ctx, mt: MetaApiManager, a: AgentFull, b: BuiltContext): Promise<RiskContext> {
  const acc: AccountRef = { id: a.acc_id, metaapi_account_id: a.metaapi_account_id, server: a.server };
  const [tradingEnabled, rg, bo] = await Promise.all([getSetting(ctx, "trading_enabled"), getSetting(ctx, "risk_global"), getSetting(ctx, "event_blackout")]);
  const [snap] = await ctx.sql<{ equity: number }[]>`select equity from account_snapshots where mt_account_id = ${a.acc_id} order by taken_at desc limit 1`;
  const accountEquity = snap?.equity ?? (await mt.accountInformation(a.metaapi_account_id)).equity;

  const open = await ctx.sql<{ agent_id: string; symbol: string; direction: "long" | "short"; entry_price: number; current_sl: number | null; volume_open: number; risk_amount: number }[]>`
    select agent_id, symbol, direction, entry_price, current_sl, volume_open, risk_amount from trades where mt_account_id = ${a.acc_id} and status = 'open'`;
  const openPositions: OpenPositionRisk[] = [];
  for (const t of open) {
    const spec = await getSpec(ctx, mt, acc, t.symbol);
    const q = b.quotes.get(t.symbol) ?? (await mt.symbolPrice(a.metaapi_account_id, t.symbol));
    openPositions.push({
      agentId: t.agent_id, symbol: t.symbol, direction: t.direction, currencies: symbolCurrencies(spec),
      riskAmount: openPositionRisk(t.direction, t.entry_price, t.current_sl, t.volume_open, spec, q.lossTickValue, t.risk_amount),
    });
  }
  const events = await ctx.sql<{ scheduled_at: Date; currency: string | null; importance: "low" | "medium" | "high" | "holiday"; title: string }[]>`
    select scheduled_at, currency, importance, title from economic_events
    where scheduled_at between now() - interval '2 hours' and now() + interval '2 hours'`;

  return {
    now: new Date(),
    tradingEnabled,
    accountType: a.account_type,
    accountEquity,
    agent: {
      id: a.id, status: a.status, style: a.style, instruments: a.instruments, allocatedCapital: a.allocated_capital,
      equity: b.equity, peakEquity: b.peakEquity, dayStartEquity: b.dayStartEquity, riskPerTradePct: a.risk_per_trade_pct,
      maxOpenPositions: a.max_open_positions, maxDailyLossPct: a.max_daily_loss_pct, maxDrawdownPct: a.max_drawdown_pct,
    },
    openPositions,
    limits: { maxAccountOpenRiskPct: rg.max_account_open_risk_pct, maxCurrencyExposurePct: rg.max_currency_exposure_pct, minRr: rg.min_rr, maxSpreadMultiple: rg.max_spread_multiple },
    blackout: { minutesBefore: bo.minutes_before, minutesAfter: bo.minutes_after, importance: bo.importance, appliesToStyles: bo.applies_to_styles },
    events: events.map((e) => ({ scheduledAt: e.scheduled_at, currency: e.currency, importance: e.importance, title: e.title })),
  };
}

async function handleDecision(ctx: Ctx, mt: MetaApiManager, a: AgentFull, runId: string, b: BuiltContext, d: ModelDecision, marketView: string, llmCallId: string): Promise<void> {
  const acc: AccountRef = { id: a.acc_id, metaapi_account_id: a.metaapi_account_id, server: a.server };
  const agentRef: AgentRef = { id: a.id, code: a.code, magic: a.magic };

  // Resolve the target trade for position actions.
  let trade: (TradeRow & { status: string }) | null = null;
  let targetError: string | null = null;
  if (d.position_ref) {
    const tradeId = b.positionsByRef.get(d.position_ref);
    if (!tradeId) targetError = `unknown position_ref ${d.position_ref}`;
    else {
      const [t] = await ctx.sql<(TradeRow & { status: string })[]>`
        select id, agent_id, position_id, symbol, direction, volume_open, current_sl, current_tp, status from trades where id = ${tradeId}`;
      trade = t ?? null;
      if (!trade || trade.status !== "open") targetError = `position ${d.position_ref} is no longer open`;
    }
  }
  if (d.action === "add" && trade && d.symbol && d.symbol !== trade.symbol) targetError = `add symbol ${d.symbol} differs from position ${trade.symbol}`;

  const snapshotRef = { run_id: runId, llm_call_id: llmCallId, market_view: marketView };
  const symbol = d.symbol ?? trade?.symbol ?? null;

  // Build the risk intent.
  let evaluation: RiskEvaluation | null = null;
  let intentError = targetError;
  if (!intentError && (d.action === "open_long" || d.action === "open_short" || d.action === "add")) {
    const direction = d.action === "add" ? trade!.direction : d.action === "open_long" ? "long" : "short";
    const spec = await getSpec(ctx, mt, acc, symbol!);
    const quote = b.quotes.get(symbol!) ?? (await mt.symbolPrice(a.metaapi_account_id, symbol!));
    const intent: Intent = {
      kind: "open", action: d.action, symbol: symbol!, direction, stopLoss: d.stop_loss!, takeProfit: d.take_profit,
      probability: d.probability!, spec, quote, medianSpreadPoints: await medianSpread(ctx, a.server, symbol!),
    };
    evaluation = evaluateRisk(await riskContext(ctx, mt, a, b), intent);
  } else if (!intentError && d.action === "modify_position") {
    const spec = await getSpec(ctx, mt, acc, trade!.symbol);
    const quote = b.quotes.get(trade!.symbol) ?? (await mt.symbolPrice(a.metaapi_account_id, trade!.symbol));
    evaluation = evaluateRisk(await riskContext(ctx, mt, a, b), {
      kind: "modify", direction: trade!.direction, symbol: trade!.symbol, currentSl: trade!.current_sl,
      newSl: d.stop_loss, newTp: d.take_profit, spec, quote,
    });
  } else if (!intentError && (d.action === "close" || d.action === "partial_close")) {
    evaluation = evaluateRisk(await riskContext(ctx, mt, a, b), { kind: "reduce" });
  }

  const executable = !intentError && evaluation !== null;
  const passed = executable && evaluation!.passed;
  const riskCheck = intentError
    ? { passed: false, gates: [{ gate: "target", passed: false, detail: intentError }] }
    : evaluation ? { passed: evaluation.passed, gates: evaluation.gates, sizing: evaluation.sizing, entry: evaluation.entry } : null;

  const status = d.action === "hold" || d.action === "skip" ? "recorded" : passed ? "submitted" : "rejected_risk";
  const [dec] = await ctx.sql<{ id: string }[]>`
    insert into decisions (run_id, agent_id, strategy_version_id, model_id, mt_account_id, symbol, action, target_trade_id,
                           probability, expected_r, entry_price, stop_loss, take_profit, close_fraction, volume, rationale,
                           factors, context_snapshot, brief_id, lessons_used, risk_check, risk_passed, status, error)
    values (${runId}, ${a.id}, ${a.strategy_version_id}, ${a.model_id}, ${a.acc_id}, ${symbol}, ${d.action},
            ${trade?.id ?? null}, ${d.probability}, ${d.expected_r}, ${evaluation?.entry ?? null}, ${d.stop_loss}, ${d.take_profit},
            ${d.action === "partial_close" ? d.close_fraction : d.action === "close" ? 1 : null},
            ${evaluation?.sizing?.volume ?? null}, ${d.rationale}, ${d.factors},
            ${ctx.sql.json({ ...b.json, _ref: snapshotRef } as never)}, ${b.briefId}, ${b.lessonIds},
            ${riskCheck ? ctx.sql.json(riskCheck as never) : null}, ${riskCheck ? passed : null}, ${status}, ${intentError})
    returning id`;
  const decisionId = dec!.id;

  if (status !== "submitted") {
    if (status === "rejected_risk") {
      const failed = (riskCheck?.gates ?? []).filter((g) => !g.passed).map((g) => `${g.gate}: ${g.detail}`).join("; ");
      ctx.log.info({ agent: a.code, action: d.action, symbol, failed }, "decision rejected by risk gates");
    }
    return;
  }

  let outcome: { ok: boolean; error?: string };
  if (d.action === "open_long" || d.action === "open_short" || d.action === "add") {
    const direction = d.action === "add" ? trade!.direction : d.action === "open_long" ? "long" : "short";
    outcome = await openPosition(ctx, mt, {
      acc, agent: agentRef, decisionId, symbol: symbol!, direction, volume: evaluation!.sizing!.volume,
      requestedPrice: evaluation!.entry!, sl: d.stop_loss!, tp: d.take_profit, plannedRisk: evaluation!.sizing!.riskAmount,
      riskPct: a.risk_per_trade_pct,
    });
    if (outcome.ok) {
      const tg = await getSetting(ctx, "telegram");
      if (tg.notify_trades) {
        await notify(ctx, `📈 <b>${escapeHtml(a.code)}</b> ${direction} ${escapeHtml(symbol!)} ${evaluation!.sizing!.volume} lot @ ${evaluation!.entry} ` +
          `SL ${d.stop_loss} TP ${d.take_profit ?? "—"} (p=${d.probability})`).catch(() => undefined);
      }
    }
  } else if (d.action === "modify_position") {
    outcome = await modifyTrade(ctx, mt, acc, agentRef, decisionId, trade!, d.stop_loss, d.take_profit, "agent");
  } else {
    outcome = await closeTrade(ctx, mt, acc, agentRef, decisionId, trade!, d.action === "close" ? 1 : d.close_fraction!, "agent");
  }
  await ctx.sql`update decisions set status = ${outcome.ok ? "executed" : "failed"}, error = ${outcome.error ?? null} where id = ${decisionId}`;
  if (!outcome.ok) {
    await systemEvent(ctx, "error", "execution", "order_failed", `${a.code} ${d.action} ${symbol}: ${outcome.error}`, { agentId: a.id, mtAccountId: a.acc_id });
  }
}
