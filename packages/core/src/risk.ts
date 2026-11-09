import { floorToStep, round2 } from "./numbers.js";

export type Direction = "long" | "short";
export type ActionKind =
  | "open_long" | "open_short" | "modify_position" | "add" | "partial_close" | "close" | "hold" | "skip";

export interface SymbolSpec {
  symbol: string;
  digits: number;
  point: number;
  tickSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevelPoints: number;
  currencyBase: string | null;
  currencyProfit: string | null;
}

export interface Quote {
  bid: number;
  ask: number;
  /** Loss in account currency for 1 lot when price moves by one tickSize against the position. */
  lossTickValue: number;
}

export interface SizingResult {
  volume: number;
  riskAmount: number;
  lossPerLot: number;
}

/** Price at which a market order of the given direction is filled. */
export function marketEntry(direction: Direction, q: Quote): number {
  return direction === "long" ? q.ask : q.bid;
}

/**
 * Position size such that hitting the stop loses at most `maxRisk` (account currency).
 * Returns null when even the minimum volume would exceed the risk budget.
 */
export function sizePosition(
  maxRisk: number,
  entry: number,
  stop: number,
  spec: SymbolSpec,
  quote: Quote,
): SizingResult | null {
  if (!(maxRisk > 0)) return null;
  if (!(quote.lossTickValue > 0)) throw new Error(`invalid lossTickValue for ${spec.symbol}`);
  const distance = Math.abs(entry - stop);
  if (!(distance > 0)) return null;
  const ticks = distance / spec.tickSize;
  const lossPerLot = ticks * quote.lossTickValue;
  const raw = maxRisk / lossPerLot;
  let volume = floorToStep(Math.min(raw, spec.volumeMax), spec.volumeStep);
  if (volume < spec.volumeMin) return null;
  volume = Math.min(volume, spec.volumeMax);
  return { volume, riskAmount: round2(volume * lossPerLot), lossPerLot };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface GateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface UpcomingEvent {
  scheduledAt: Date;
  currency: string | null;
  importance: "low" | "medium" | "high" | "holiday";
  title: string;
}

export interface OpenPositionRisk {
  agentId: string;
  symbol: string;
  direction: Direction;
  riskAmount: number; // current risk to stop in account currency (0 if stop at/through breakeven)
  currencies: string[];
}

export interface RiskContext {
  now: Date;
  tradingEnabled: boolean;
  accountType: "demo" | "real";
  accountEquity: number;
  agent: {
    id: string;
    status: string;
    style: "swing" | "day" | "event" | "other";
    instruments: string[];
    allocatedCapital: number;
    equity: number;
    peakEquity: number;
    dayStartEquity: number;
    riskPerTradePct: number;
    maxOpenPositions: number;
    maxDailyLossPct: number;
    maxDrawdownPct: number;
  };
  openPositions: OpenPositionRisk[]; // all positions on the account (all agents)
  limits: {
    maxAccountOpenRiskPct: number;
    maxCurrencyExposurePct: number;
    minRr: number;
    maxSpreadMultiple: number;
  };
  blackout: {
    minutesBefore: number;
    minutesAfter: number;
    importance: string[];
    appliesToStyles: string[];
  };
  events: UpcomingEvent[];
}

export interface OpenIntent {
  kind: "open";
  action: "open_long" | "open_short" | "add";
  symbol: string;
  direction: Direction;
  stopLoss: number;
  takeProfit: number | null;
  probability: number;
  spec: SymbolSpec;
  quote: Quote;
  medianSpreadPoints: number | null;
}

export interface ModifyIntent {
  kind: "modify";
  direction: Direction;
  symbol: string;
  currentSl: number | null;
  newSl: number | null;
  newTp: number | null;
  spec: SymbolSpec;
  quote: Quote;
}

export interface ReduceIntent {
  kind: "reduce";
}

export type Intent = OpenIntent | ModifyIntent | ReduceIntent;

export interface RiskEvaluation {
  passed: boolean;
  gates: GateResult[];
  sizing: SizingResult | null;
  entry: number | null;
}

const pass = (gate: string, detail: string): GateResult => ({ gate, passed: true, detail });
const fail = (gate: string, detail: string): GateResult => ({ gate, passed: false, detail });

export function symbolCurrencies(spec: SymbolSpec): string[] {
  return [spec.currencyBase, spec.currencyProfit].filter((c): c is string => !!c);
}

/**
 * Hard risk checks executed in code before any order. The model cannot bypass
 * them. All gates are evaluated (not short-circuited) so the decision log shows
 * the full picture.
 */
export function evaluateRisk(ctx: RiskContext, intent: Intent): RiskEvaluation {
  const gates: GateResult[] = [];

  if (intent.kind === "reduce") {
    // Closing or reducing a position always lowers risk; it is never blocked.
    gates.push(pass("risk_reducing", "closing/reducing exposure is always allowed"));
    return { passed: true, gates, sizing: null, entry: null };
  }

  gates.push(ctx.tradingEnabled ? pass("trading_enabled", "global switch on") : fail("trading_enabled", "global trading switch is off"));
  gates.push(ctx.accountType === "demo" ? pass("demo_account", "demo account") : fail("demo_account", "real-money accounts are blocked"));
  gates.push(ctx.agent.status === "active" ? pass("agent_active", "agent active") : fail("agent_active", `agent status is ${ctx.agent.status}`));

  if (intent.kind === "modify") {
    const { direction, currentSl, newSl, newTp, quote, spec } = intent;
    const ref = direction === "long" ? quote.bid : quote.ask; // price that triggers stops
    if (newSl !== null) {
      if (currentSl !== null) {
        const tightens = direction === "long" ? newSl >= currentSl : newSl <= currentSl;
        gates.push(tightens
          ? pass("sl_only_tightens", `SL ${currentSl} -> ${newSl}`)
          : fail("sl_only_tightens", `moving SL away from price (${currentSl} -> ${newSl}) is not allowed`));
      } else {
        gates.push(pass("sl_only_tightens", "position had no SL; setting one"));
      }
      const valid = direction === "long" ? newSl < ref : newSl > ref;
      gates.push(valid ? pass("sl_side", "SL on the correct side of price") : fail("sl_side", `SL ${newSl} is on the wrong side of price ${ref}`));
      const dist = Math.abs(ref - newSl) / spec.point;
      gates.push(dist >= spec.stopsLevelPoints
        ? pass("stops_level", `${dist.toFixed(1)} pts >= ${spec.stopsLevelPoints}`)
        : fail("stops_level", `SL ${dist.toFixed(1)} pts from price, broker minimum ${spec.stopsLevelPoints}`));
    }
    if (newTp !== null) {
      const valid = direction === "long" ? newTp > ref : newTp < ref;
      gates.push(valid ? pass("tp_side", "TP on the correct side of price") : fail("tp_side", `TP ${newTp} is on the wrong side of price ${ref}`));
    }
    if (newSl === null && newTp === null) gates.push(fail("modify_has_change", "nothing to modify"));
    return { passed: gates.every((g) => g.passed), gates, sizing: null, entry: null };
  }

  // ---- opening / adding exposure ----
  const { symbol, direction, stopLoss, takeProfit, spec, quote, probability } = intent;
  const a = ctx.agent;

  gates.push(a.instruments.includes(symbol) ? pass("instrument_allowed", symbol) : fail("instrument_allowed", `${symbol} is not in the agent's instrument list`));
  gates.push(probability >= 0 && probability <= 1 ? pass("probability_range", String(probability)) : fail("probability_range", `probability ${probability} outside 0..1`));

  const entry = marketEntry(direction, quote);
  const slOk = direction === "long" ? stopLoss < entry : stopLoss > entry;
  gates.push(slOk ? pass("sl_side", `SL ${stopLoss} vs entry ${entry}`) : fail("sl_side", `SL ${stopLoss} is on the wrong side of entry ${entry}`));

  const stopRef = direction === "long" ? quote.bid : quote.ask;
  const slDistPts = Math.abs(stopRef - stopLoss) / spec.point;
  gates.push(slDistPts >= spec.stopsLevelPoints
    ? pass("stops_level", `${slDistPts.toFixed(1)} pts >= ${spec.stopsLevelPoints}`)
    : fail("stops_level", `SL ${slDistPts.toFixed(1)} pts from price, broker minimum ${spec.stopsLevelPoints}`));

  if (takeProfit !== null) {
    const tpOk = direction === "long" ? takeProfit > entry : takeProfit < entry;
    gates.push(tpOk ? pass("tp_side", `TP ${takeProfit}`) : fail("tp_side", `TP ${takeProfit} is on the wrong side of entry ${entry}`));
    const rr = Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss);
    gates.push(rr >= ctx.limits.minRr
      ? pass("min_rr", `R:R ${rr.toFixed(2)} >= ${ctx.limits.minRr}`)
      : fail("min_rr", `R:R ${rr.toFixed(2)} below minimum ${ctx.limits.minRr}`));
  }

  const spreadPts = (quote.ask - quote.bid) / spec.point;
  if (intent.medianSpreadPoints !== null && intent.medianSpreadPoints > 0) {
    const limit = intent.medianSpreadPoints * ctx.limits.maxSpreadMultiple;
    gates.push(spreadPts <= limit
      ? pass("spread", `${spreadPts.toFixed(1)} pts <= ${limit.toFixed(1)}`)
      : fail("spread", `spread ${spreadPts.toFixed(1)} pts exceeds ${ctx.limits.maxSpreadMultiple}x median (${intent.medianSpreadPoints.toFixed(1)})`));
  } else {
    gates.push(pass("spread", `${spreadPts.toFixed(1)} pts (no median yet)`));
  }

  const own = ctx.openPositions.filter((p) => p.agentId === a.id);
  gates.push(own.length < a.maxOpenPositions
    ? pass("max_open_positions", `${own.length}/${a.maxOpenPositions}`)
    : fail("max_open_positions", `agent already has ${own.length}/${a.maxOpenPositions} positions`));

  if (intent.action !== "add") {
    const dup = own.some((p) => p.symbol === symbol && p.direction === direction);
    gates.push(dup
      ? fail("no_duplicate", `agent already holds ${direction} ${symbol}; use "add" to pyramid`)
      : pass("no_duplicate", "no open position in the same direction"));
  }

  const dailyLossPct = ((a.dayStartEquity - a.equity) / a.allocatedCapital) * 100;
  gates.push(dailyLossPct < a.maxDailyLossPct
    ? pass("daily_loss", `${dailyLossPct.toFixed(2)}% < ${a.maxDailyLossPct}%`)
    : fail("daily_loss", `daily loss ${dailyLossPct.toFixed(2)}% reached limit ${a.maxDailyLossPct}%`));

  const ddPct = a.peakEquity > 0 ? ((a.peakEquity - a.equity) / a.peakEquity) * 100 : 0;
  gates.push(ddPct < a.maxDrawdownPct
    ? pass("drawdown", `${ddPct.toFixed(2)}% < ${a.maxDrawdownPct}%`)
    : fail("drawdown", `drawdown ${ddPct.toFixed(2)}% reached limit ${a.maxDrawdownPct}%`));

  // Event blackout (not for event strategies, which trade around events by design).
  if (ctx.blackout.appliesToStyles.includes(a.style)) {
    const ccys = symbolCurrencies(spec);
    const t = ctx.now.getTime();
    const hit = ctx.events.find((e) =>
      ctx.blackout.importance.includes(e.importance) &&
      e.currency !== null && ccys.includes(e.currency) &&
      t >= e.scheduledAt.getTime() - ctx.blackout.minutesBefore * 60_000 &&
      t <= e.scheduledAt.getTime() + ctx.blackout.minutesAfter * 60_000);
    gates.push(hit
      ? fail("event_blackout", `${hit.title} (${hit.currency}) at ${hit.scheduledAt.toISOString()}`)
      : pass("event_blackout", "no high-impact event in window"));
  }

  // Sizing from the agent's own virtual equity.
  const budget = (a.equity * a.riskPerTradePct) / 100;
  const sizing = slOk ? sizePosition(budget, entry, stopLoss, spec, quote) : null;
  gates.push(sizing
    ? pass("position_size", `${sizing.volume} lots, risk ${sizing.riskAmount} (budget ${round2(budget)})`)
    : fail("position_size", `cannot size within risk budget ${round2(budget)} (min volume ${spec.volumeMin})`));

  if (sizing) {
    const accountRisk = ctx.openPositions.reduce((s, p) => s + p.riskAmount, 0) + sizing.riskAmount;
    const accountRiskPct = (accountRisk / ctx.accountEquity) * 100;
    gates.push(accountRiskPct <= ctx.limits.maxAccountOpenRiskPct
      ? pass("account_open_risk", `${accountRiskPct.toFixed(2)}% <= ${ctx.limits.maxAccountOpenRiskPct}%`)
      : fail("account_open_risk", `account open risk would be ${accountRiskPct.toFixed(2)}% (limit ${ctx.limits.maxAccountOpenRiskPct}%)`));

    for (const ccy of symbolCurrencies(spec)) {
      const exposure = ctx.openPositions
        .filter((p) => p.currencies.includes(ccy))
        .reduce((s, p) => s + p.riskAmount, 0) + sizing.riskAmount;
      const pct = (exposure / ctx.accountEquity) * 100;
      gates.push(pct <= ctx.limits.maxCurrencyExposurePct
        ? pass(`currency_exposure_${ccy}`, `${pct.toFixed(2)}% <= ${ctx.limits.maxCurrencyExposurePct}%`)
        : fail(`currency_exposure_${ccy}`, `${ccy} risk would be ${pct.toFixed(2)}% (limit ${ctx.limits.maxCurrencyExposurePct}%)`));
    }
  }

  return { passed: gates.every((g) => g.passed), gates, sizing, entry };
}

/** Current risk-to-stop of an open position in account currency (0 when the stop locks in profit). */
export function openPositionRisk(
  direction: Direction,
  entry: number,
  stop: number | null,
  volume: number,
  spec: SymbolSpec,
  lossTickValue: number,
  fallbackRisk: number,
): number {
  if (stop === null) return fallbackRisk;
  const lossDistance = direction === "long" ? entry - stop : stop - entry;
  if (lossDistance <= 0) return 0;
  return round2((lossDistance / spec.tickSize) * lossTickValue * volume);
}
