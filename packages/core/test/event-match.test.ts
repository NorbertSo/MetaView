import { describe, expect, it } from "vitest";
import { formatFigure, matchEvents, titleSimilarity, type CalendarEvent } from "../src/event-match.js";

const at = (iso: string) => new Date(iso);
const ev = (title: string, currency: string, time: string, forecast: number | null, previous: number | null): CalendarEvent =>
  ({ title, currency, at: at(time), forecast, previous });

describe("event matching (ForexFactory ↔ TradingView)", () => {
  // Real rows from 17–18 Nov 2026.
  const ff = [
    ev("Retail Sales m/m", "USD", "2026-11-17T13:30:00Z", 0.1, 0.8),
    ev("Core Retail Sales m/m", "USD", "2026-11-17T13:30:00Z", 0.4, 0.9),
    ev("CPI y/y", "GBP", "2026-11-18T07:00:00Z", 3.6, 3.5),
    ev("Average Earnings Index 3m/y", "GBP", "2026-11-17T07:00:00Z", 3.5, 3.7),
    ev("BOE Gov Bailey Speaks", "GBP", "2026-11-18T08:30:00Z", null, null),
  ];
  const tv = [
    ev("Retail Sales Ex Autos MoM", "USD", "2026-11-17T13:30:00Z", 0.4, 1.1),
    ev("Retail Sales MoM", "USD", "2026-11-17T13:30:00Z", 0.2, 0.8),
    ev("Retail Sales YoY", "USD", "2026-11-17T13:30:00Z", null, 4.1),
    ev("Core Inflation Rate YoY", "GBP", "2026-11-18T07:00:00Z", 3.4, 3.4),
    ev("Inflation Rate YoY", "GBP", "2026-11-18T07:00:00Z", 3.6, 3.5),
    ev("Average Earnings Excluding Bonus", "GBP", "2026-11-17T07:00:00Z", 3.6, 3.7),
    ev("Average Earnings incl. Bonus (3Mo/Yr)", "GBP", "2026-11-17T07:00:00Z", 3.5, 3.8),
    ev("NOPA Soybean Oil Stocks", "USD", "2026-11-17T17:00:00Z", 1.089, 1.053),
  ];
  const m = matchEvents(ff, tv);

  it("matches renamed releases", () => {
    expect(tv[m.get(0)!]!.title).toBe("Retail Sales MoM");
    expect(tv[m.get(1)!]!.title).toBe("Retail Sales Ex Autos MoM");
    expect(tv[m.get(2)!]!.title).toBe("Inflation Rate YoY");
    expect(tv[m.get(3)!]!.title).toBe("Average Earnings incl. Bonus (3Mo/Yr)");
  });

  it("leaves speeches without a counterpart unmatched", () => {
    expect(m.has(4)).toBe(false);
  });

  it("never matches across currencies or far-apart times", () => {
    const x = matchEvents([ev("CPI y/y", "EUR", "2026-11-18T07:00:00Z", 3.6, 3.5)], [tv[4]!]);
    expect(x.size).toBe(0);
    const y = matchEvents([ev("CPI y/y", "GBP", "2026-11-18T09:00:00Z", 3.6, 3.5)], [tv[4]!]);
    expect(y.size).toBe(0);
  });

  it("scores title similarity", () => {
    expect(titleSimilarity("CPI m/m", "Inflation Rate MoM")).toBeGreaterThan(0.5);
    expect(titleSimilarity("Fed Chairman Speaks", "NOPA Soybean Oil Stocks")).toBe(0);
  });

  it("formats figures like the calendar", () => {
    expect(formatFigure(0.2, "%", null)).toBe("0.2%");
    expect(formatFigure(25.5, null, "K")).toBe("25.5K");
    expect(formatFigure(-39.3, null, "K")).toBe("-39.3K");
  });
});
