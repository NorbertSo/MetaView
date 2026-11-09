import { describe, expect, it } from "vitest";
import { generateKeyPair, open, privateKeyFromBase64, publicKeyFromBase64, seal } from "../src/crypto.js";
import { floorToStep } from "../src/numbers.js";
import { evaluateRisk, sizePosition, type RiskContext, type SymbolSpec } from "../src/risk.js";
import { ModelDecisionBatch } from "../src/decision-schema.js";
import { evaluateCriteria } from "../src/criteria.js";
import { validateCron } from "../src/cron.js";
import { llmCostUsd } from "../src/pricing.js";

const eurusd: SymbolSpec = {
  symbol: "EURUSD", digits: 5, point: 0.00001, tickSize: 0.00001,
  volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, stopsLevelPoints: 0,
  currencyBase: "EUR", currencyProfit: "USD",
};
// 1 lot EURUSD: 1 tick (0.00001) = 1 USD
const quote = { bid: 1.10000, ask: 1.10010, lossTickValue: 1 };

function ctx(over: Partial<RiskContext> = {}): RiskContext {
  return {
    now: new Date("2026-11-10T10:00:00Z"),
    tradingEnabled: true,
    accountType: "demo",
    accountEquity: 100_000,
    agent: {
      id: "a1", status: "active", style: "swing", instruments: ["EURUSD"],
      allocatedCapital: 10_000, equity: 10_000, peakEquity: 10_000, dayStartEquity: 10_000,
      riskPerTradePct: 1, maxOpenPositions: 3, maxDailyLossPct: 3, maxDrawdownPct: 20,
    },
    openPositions: [],
    limits: { maxAccountOpenRiskPct: 10, maxCurrencyExposurePct: 6, minRr: 1, maxSpreadMultiple: 3 },
    blackout: { minutesBefore: 15, minutesAfter: 10, importance: ["high"], appliesToStyles: ["swing", "day", "other"] },
    events: [],
    ...over,
  };
}

const openLong = (sl = 1.09910, tp: number | null = 1.10310) => ({
  kind: "open" as const, action: "open_long" as const, symbol: "EURUSD", direction: "long" as const,
  stopLoss: sl, takeProfit: tp, probability: 0.55, spec: eurusd, quote, medianSpreadPoints: 10,
});

describe("crypto", () => {
  it("seals and opens; public key cannot decrypt", () => {
    const kp = generateKeyPair();
    const sealed = seal("sk-ant-secret-123", publicKeyFromBase64(kp.publicKey));
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(open(sealed, privateKeyFromBase64(kp.privateKey))).toBe("sk-ant-secret-123");
    const other = generateKeyPair();
    expect(() => open(sealed, privateKeyFromBase64(other.privateKey))).toThrow();
  });
  it("detects tampering", () => {
    const kp = generateKeyPair();
    const sealed = seal("abc", publicKeyFromBase64(kp.publicKey));
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
    expect(() => open(tampered, privateKeyFromBase64(kp.privateKey))).toThrow();
  });
});

describe("numbers", () => {
  it("floors to step without FP drift", () => {
    expect(floorToStep(0.2999, 0.01)).toBe(0.29);
    expect(floorToStep(0.1 + 0.2, 0.1)).toBe(0.3); // FP noise absorbed
    expect(floorToStep(0.3, 0.01)).toBe(0.3);
    expect(floorToStep(1.23456, 0.001)).toBe(1.234);
    expect(floorToStep(7, 1)).toBe(7);
  });
});

describe("sizing", () => {
  it("risks at most the budget", () => {
    // entry 1.10010, SL 1.09910 = 100 ticks = 100 USD per lot; budget 100 => 1.00 lot
    const s = sizePosition(100, 1.1001, 1.0991, eurusd, quote)!;
    expect(s.volume).toBe(1);
    expect(s.riskAmount).toBeLessThanOrEqual(100);
  });
  it("returns null when min volume exceeds budget", () => {
    expect(sizePosition(0.5, 1.1001, 1.0991, eurusd, quote)).toBeNull();
  });
});

describe("risk gates", () => {
  it("passes a clean long and sizes from agent equity", () => {
    const r = evaluateRisk(ctx(), openLong());
    expect(r.passed).toBe(true);
    expect(r.sizing!.volume).toBe(1); // 1% of 10k = 100 USD over 100 ticks
    expect(r.entry).toBe(1.1001);
  });
  it("rejects SL on the wrong side", () => {
    const r = evaluateRisk(ctx(), openLong(1.101));
    expect(r.passed).toBe(false);
    expect(r.gates.find((g) => g.gate === "sl_side")!.passed).toBe(false);
  });
  it("rejects poor R:R", () => {
    const r = evaluateRisk(ctx(), openLong(1.09910, 1.10050));
    expect(r.gates.find((g) => g.gate === "min_rr")!.passed).toBe(false);
  });
  it("blocks when trading disabled or account is real", () => {
    expect(evaluateRisk(ctx({ tradingEnabled: false }), openLong()).passed).toBe(false);
    expect(evaluateRisk(ctx({ accountType: "real" }), openLong()).passed).toBe(false);
  });
  it("enforces daily loss and drawdown from the agent's own equity", () => {
    const daily = ctx({ agent: { ...ctx().agent, equity: 9_650, dayStartEquity: 10_000, peakEquity: 10_000 } });
    expect(evaluateRisk(daily, openLong()).gates.find((g) => g.gate === "daily_loss")!.passed).toBe(false);
    const dd = ctx({ agent: { ...ctx().agent, equity: 7_900, dayStartEquity: 7_900, peakEquity: 10_000 } });
    expect(evaluateRisk(dd, openLong()).gates.find((g) => g.gate === "drawdown")!.passed).toBe(false);
  });
  it("applies event blackout to swing but not to event strategies", () => {
    const events = [{ scheduledAt: new Date("2026-11-10T10:05:00Z"), currency: "USD", importance: "high" as const, title: "CPI" }];
    expect(evaluateRisk(ctx({ events }), openLong()).gates.find((g) => g.gate === "event_blackout")!.passed).toBe(false);
    const ev = ctx({ events, agent: { ...ctx().agent, style: "event" } });
    expect(evaluateRisk(ev, openLong()).gates.some((g) => g.gate === "event_blackout")).toBe(false);
  });
  it("counts other agents' risk at account level but positions only per agent", () => {
    const others = Array.from({ length: 3 }, (_, i) => ({ agentId: `b${i}`, symbol: "GBPJPY", direction: "long" as const, riskAmount: 3_000, currencies: ["GBP", "JPY"] }));
    const r = evaluateRisk(ctx({ openPositions: others }), openLong());
    expect(r.gates.find((g) => g.gate === "max_open_positions")!.passed).toBe(true);
    expect(r.gates.find((g) => g.gate === "account_open_risk")!.passed).toBe(true); // 9000+100 = 9.1%
    const r2 = evaluateRisk(ctx({ openPositions: [...others, { agentId: "b9", symbol: "USDJPY", direction: "short", riskAmount: 1_000, currencies: ["USD", "JPY"] }] }), openLong());
    expect(r2.gates.find((g) => g.gate === "account_open_risk")!.passed).toBe(false);
  });
  it("prevents duplicate positions unless pyramiding with add", () => {
    const own = [{ agentId: "a1", symbol: "EURUSD", direction: "long" as const, riskAmount: 100, currencies: ["EUR", "USD"] }];
    expect(evaluateRisk(ctx({ openPositions: own }), openLong()).gates.find((g) => g.gate === "no_duplicate")!.passed).toBe(false);
    const add = { ...openLong(), action: "add" as const };
    expect(evaluateRisk(ctx({ openPositions: own }), add).gates.some((g) => g.gate === "no_duplicate")).toBe(false);
  });
  it("only allows SL to tighten", () => {
    const base = { kind: "modify" as const, direction: "long" as const, symbol: "EURUSD", spec: eurusd, quote, newTp: null };
    expect(evaluateRisk(ctx(), { ...base, currentSl: 1.0991, newSl: 1.0995 }).passed).toBe(true);
    const widen = evaluateRisk(ctx(), { ...base, currentSl: 1.0991, newSl: 1.0980 });
    expect(widen.passed).toBe(false);
    expect(widen.gates.find((g) => g.gate === "sl_only_tightens")!.passed).toBe(false);
  });
  it("never blocks risk-reducing actions", () => {
    expect(evaluateRisk(ctx({ tradingEnabled: false }), { kind: "reduce" }).passed).toBe(true);
  });
});

describe("model output schema", () => {
  it("requires SL and probability for opens", () => {
    const bad = ModelDecisionBatch.safeParse({
      market_view: "Dollar weak after data release.",
      decisions: [{ action: "open_long", symbol: "EURUSD", position_ref: null, probability: null, stop_loss: null,
        take_profit: null, close_fraction: null, expected_r: null, rationale: "Breakout above range high.", factors: [] }],
    });
    expect(bad.success).toBe(false);
  });
  it("accepts a skip", () => {
    const ok = ModelDecisionBatch.safeParse({
      market_view: "Nothing aligns with the rules today.",
      decisions: [{ action: "skip", symbol: null, position_ref: null, probability: null, stop_loss: null,
        take_profit: null, close_fraction: null, expected_r: null, rationale: "No setup meets the entry rules.", factors: ["no_setup"] }],
    });
    expect(ok.success).toBe(true);
  });
});

describe("criteria", () => {
  const c = { min_period_days: 90, min_trades: 30, min_expectancy_r: 0, max_drawdown_pct: 20, min_profit_factor: 1.2, max_brier: null };
  const now = new Date("2026-12-01T00:00:00Z");
  it("stays in progress until the sample is complete", () => {
    const v = evaluateCriteria(c, { closed_trades: 10, expectancy_r: 0.5, max_drawdown_pct: 5, profit_factor: 2, brier: null, first_trade_at: new Date("2026-11-01") }, now);
    expect(v.verdict).toBe("in_progress");
  });
  it("fails early on drawdown", () => {
    const v = evaluateCriteria(c, { closed_trades: 10, expectancy_r: 0.5, max_drawdown_pct: 25, profit_factor: 2, brier: null, first_trade_at: new Date("2026-11-01") }, now);
    expect(v.verdict).toBe("failed");
  });
  it("passes when everything is met", () => {
    const v = evaluateCriteria(c, { closed_trades: 40, expectancy_r: 0.2, max_drawdown_pct: 10, profit_factor: 1.5, brier: null, first_trade_at: new Date("2026-08-01") }, now);
    expect(v.verdict).toBe("passed");
  });
});

describe("cron & pricing", () => {
  it("validates cron and min interval", () => {
    expect(validateCron("*/15 * * * 1-5").ok).toBe(true);
    expect(validateCron("* * * * *").ok).toBe(false);
    expect(validateCron("not a cron").ok).toBe(false);
  });
  it("computes LLM cost", () => {
    expect(llmCostUsd({ input_usd_per_mtok: 4, output_usd_per_mtok: 20, cache_read_usd_per_mtok: 0.2, cache_write_usd_per_mtok: 5 },
      { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 50_000, cacheWriteTokens: 0 })).toBe(0.07);
  });
});
