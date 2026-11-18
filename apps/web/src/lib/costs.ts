/** Instrument cost model. All money values are in the account currency, per 1 lot. */

export interface InstrumentRaw {
  swapMode?: string;
  swapRollover3Days?: string;
  swapRates?: number[]; // multiplier per weekday, Sunday first
  tradeSessions?: Record<string, { from: string; to: string }[]>;
  expirationTime?: string | null;
  priceCalculationMode?: string;
  baseCurrency?: string;
}

export interface CostInputs {
  point: number;
  tick_size: number;
  contract_size: number | null;
  swap_long: number | null;
  swap_short: number | null;
  last_bid: number | null;
  last_ask: number | null;
  tick_value: number | null; // account currency per tick per lot
  raw: InstrumentRaw;
}

/** Account-currency value of `points` price points for 1 lot. */
export function pointsValue(points: number | null, c: CostInputs): number | null {
  if (points === null || !c.tick_value || !c.tick_size) return null;
  return (points * c.point / c.tick_size) * c.tick_value;
}

function mid(c: CostInputs): number | null {
  return c.last_bid !== null && c.last_ask !== null ? (c.last_bid + c.last_ask) / 2 : null;
}

/** Notional of 1 lot in the account currency. */
export function notionalPerLot(c: CostInputs): number | null {
  const p = mid(c);
  if (p === null || !c.tick_value || !c.tick_size) return null;
  return (p / c.tick_size) * c.tick_value;
}

const SWAP_MODE: Record<string, string> = {
  SYMBOL_SWAP_MODE_DISABLED: "brak swapu",
  SYMBOL_SWAP_MODE_POINTS: "w punktach",
  SYMBOL_SWAP_MODE_INTEREST_CURRENT: "% rocznie od bieżącej ceny",
  SYMBOL_SWAP_MODE_INTEREST_OPEN: "% rocznie od ceny otwarcia",
  SYMBOL_SWAP_MODE_CURRENCY_SYMBOL: "w walucie bazowej",
  SYMBOL_SWAP_MODE_CURRENCY_MARGIN: "w walucie depozytu",
  SYMBOL_SWAP_MODE_CURRENCY_DEPOSIT: "w walucie konta",
  SYMBOL_SWAP_MODE_CURRENCY_PROFIT: "w walucie zysku",
  SYMBOL_SWAP_MODE_REOPEN_CURRENT: "zamknięcie i ponowne otwarcie",
  SYMBOL_SWAP_MODE_REOPEN_BID: "zamknięcie i ponowne otwarcie",
};

export function swapModeLabel(mode: string | undefined): string {
  return mode ? (SWAP_MODE[mode] ?? mode.replace("SYMBOL_SWAP_MODE_", "").toLowerCase()) : "—";
}

/** Swap charged (negative) or paid (positive) for holding 1 lot over one night. */
export function swapPerNight(rate: number | null, c: CostInputs): number | null {
  if (rate === null) return null;
  const mode = c.raw.swapMode ?? "";
  const conv = c.tick_value && c.tick_size && c.contract_size ? c.tick_value / (c.tick_size * c.contract_size) : null; // profit ccy -> account ccy
  switch (mode) {
    case "SYMBOL_SWAP_MODE_DISABLED": return 0;
    case "SYMBOL_SWAP_MODE_POINTS": return pointsValue(rate, c);
    case "SYMBOL_SWAP_MODE_INTEREST_CURRENT":
    case "SYMBOL_SWAP_MODE_INTEREST_OPEN": {
      const n = notionalPerLot(c);
      return n === null ? null : (n * rate) / 100 / 360;
    }
    case "SYMBOL_SWAP_MODE_CURRENCY_DEPOSIT": return rate;
    case "SYMBOL_SWAP_MODE_CURRENCY_PROFIT": return conv === null ? null : rate * conv;
    case "SYMBOL_SWAP_MODE_CURRENCY_SYMBOL":
    case "SYMBOL_SWAP_MODE_CURRENCY_MARGIN": {
      const p = mid(c);
      return conv === null || p === null ? null : rate * p * conv;
    }
    default: return null;
  }
}

const DAYS_PL = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];
const DAYS_EN = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

export function tripleSwapDay(raw: InstrumentRaw): string {
  if (raw.swapRates?.length === 7) {
    const i = raw.swapRates.findIndex((m) => m >= 3);
    if (i >= 0) return DAYS_PL[i]!;
  }
  const i = raw.swapRollover3Days ? DAYS_EN.indexOf(raw.swapRollover3Days) : -1;
  return i >= 0 ? DAYS_PL[i]! : "—";
}

/** Number of swap charges for holding a position a full week (weekend nights are booked as a triple swap). */
export function swapNightsPerWeek(raw: InstrumentRaw): number {
  return raw.swapRates?.length === 7 ? raw.swapRates.reduce((s, m) => s + m, 0) : 7;
}

export function sessionsLabel(raw: InstrumentRaw): string {
  const s = raw.tradeSessions;
  if (!s) return "—";
  const fmt = (x: { from: string; to: string }) => `${x.from.slice(0, 5)}–${x.to.slice(0, 5)}`;
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].map((d) => (s[d] ?? []).map(fmt).join(", "));
  const allSame = weekdays.every((w) => w === weekdays[0]);
  return allSame ? `pn–pt ${weekdays[0] || "zamknięty"}` : weekdays.map((w, i) => `${["pn", "wt", "śr", "cz", "pt"][i]} ${w || "—"}`).join(" · ");
}

export function rolloverLabel(raw: InstrumentRaw): string {
  if (raw.expirationTime) return `kontrakt wygasa ${new Date(raw.expirationTime).toLocaleDateString("pl-PL")} — pozycję trzeba zamknąć lub przenieść na kolejną serię`;
  return "CFD kasowy, bez rolowania i daty wygaśnięcia — utrzymanie pozycji kosztuje swap naliczany co noc";
}
