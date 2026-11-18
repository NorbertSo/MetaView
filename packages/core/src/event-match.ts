/**
 * Matches economic events from two calendars that name the same release differently
 * (ForexFactory "CPI y/y" vs TradingView "Inflation Rate YoY"). Candidates must share the
 * currency and be scheduled within a few minutes; the score combines title similarity with
 * equal forecast / previous figures, which are a strong signal that two rows are the same release.
 */

export interface CalendarEvent {
  title: string;
  currency: string | null;
  at: Date;
  forecast: number | null;
  previous: number | null;
}

const SYNONYMS: [RegExp, string][] = [
  [/\bm\/m\b/g, " mom "], [/\by\/y\b/g, " yoy "], [/\bq\/q\b/g, " qoq "], [/\b3m\/y\b/g, " 3mo yoy "],
  [/\bcpi\b/g, " cpi inflation "], [/\bppi\b/g, " ppi producer "], [/\bgdp\b/g, " gdp growth "],
  [/\bgov\b/g, " governor "], [/\bspeaks\b/g, " speech "], [/\bfomc\b/g, " fomc fed "],
  [/\bcore\b/g, " core ex excluding "], [/\bunemployment claims\b/g, " initial jobless claims "],
  [/\bnon-farm\b/g, " nonfarm "], [/\bavg\b/g, " average "], [/\bprelim\b/g, " preliminary "], [/\bflash\b/g, " flash preliminary "],
  [/\bmfg\b/g, " manufacturing "], [/\bemp\b/g, " employment "],
];
const STOP = new Set(["the", "of", "and", "s", "rate", "index", "change", "a", "in", "for"]);

export function titleTokens(title: string): Set<string> {
  let s = ` ${title.toLowerCase().replace(/[()]/g, " ")} `;
  for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
  return new Set(s.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)));
}

/** Overlap coefficient of title tokens, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a), B = titleTokens(b);
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return shared / Math.max(1, Math.min(A.size, B.size));
}

const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 1e-9;

export const MATCH_WINDOW_MINUTES = 5;

export function matchScore(a: CalendarEvent, b: CalendarEvent): number | null {
  if (!a.currency || a.currency !== b.currency) return null;
  const dtMin = Math.abs(a.at.getTime() - b.at.getTime()) / 60_000;
  if (dtMin > MATCH_WINDOW_MINUTES) return null;
  const sim = titleSimilarity(a.title, b.title);
  const prev = same(a.previous, b.previous), fc = same(a.forecast, b.forecast);
  // Without any title overlap only an exact match of both figures counts.
  if (sim < 0.34 && !(prev && fc)) return null;
  return sim + (prev ? 0.6 : 0) + (fc ? 0.4 : 0) + (dtMin === 0 ? 0.1 : 0);
}

export const MIN_MATCH_SCORE = 0.6;

/**
 * One-to-one greedy assignment: best-scoring pairs first. Returns, for each index in `targets`,
 * the index of the matched `candidates` entry.
 */
export function matchEvents(targets: CalendarEvent[], candidates: CalendarEvent[]): Map<number, number> {
  const pairs: { t: number; c: number; s: number }[] = [];
  targets.forEach((t, ti) => candidates.forEach((c, ci) => {
    const s = matchScore(t, c);
    if (s !== null && s >= MIN_MATCH_SCORE) pairs.push({ t: ti, c: ci, s });
  }));
  pairs.sort((x, y) => y.s - x.s);
  const out = new Map<number, number>();
  const usedC = new Set<number>();
  for (const p of pairs) {
    if (out.has(p.t) || usedC.has(p.c)) continue;
    out.set(p.t, p.c);
    usedC.add(p.c);
  }
  return out;
}

/** Formats a calendar figure the way ForexFactory shows it ("0.2%", "25.5K", "-39.3K"). */
export function formatFigure(value: number, unit: string | null, scale: string | null): string {
  const v = Number(value.toFixed(6)).toString();
  return `${v}${unit === "%" ? "%" : ""}${scale ?? ""}`;
}
