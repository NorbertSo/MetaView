import { localDayDiff, orbSetup, zoneSetup, type Bar, type OrbConfig, type ZoneConfig } from "@tv/core";
import type { MetaApiManager } from "../metaapi/manager.js";

/**
 * strategy_versions.params.setups — which precomputed setups this strategy gets.
 * {
 *   "orb":   { "symbols": { "GERMANY40": { "tz": "Europe/Berlin", "open": "09:00", "close": "17:30" } },
 *              "range_minutes": 60, "entry_window_minutes": 240, "sma_days": 20, "max_days": 5 },
 *   "zones": { "symbols": { "GERMANY40": { "tz": "Europe/Berlin" } }, "pivot": 5, "look_days": 80,
 *              "width_pct": 0.2, "min_reactions": 5, "trend_sma": 200, "max_days": 3 }
 * }
 */
export interface SetupParams {
  /** Skip the model call when no setup is actionable and the agent has no positions/pending orders. */
  gate?: boolean;
  orb?: { symbols: Record<string, { tz: string; open: string; close: string }>; range_minutes?: number; entry_window_minutes?: number; sma_days?: number; max_days?: number };
  zones?: { symbols: Record<string, { tz: string }>; pivot?: number; look_days?: number; width_pct?: number; min_reactions?: number; trend_sma?: number; max_days?: number };
}

const toBars = (list: { time: Date | string; open: number; high: number; low: number; close: number }[]): Bar[] =>
  list.map((c) => ({ t: new Date(c.time).getTime(), o: c.open, h: c.high, l: c.low, c: c.close })).sort((a, b) => a.t - b.t);

export interface OpenPos { position_ref: string; symbol: string; opened_at: string }

export async function computeSetups(mt: MetaApiManager, accountId: string, params: SetupParams, positions: OpenPos[], now = Date.now()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (params.orb) {
    const p = params.orb;
    for (const [symbol, s] of Object.entries(p.symbols)) {
      try {
        const cfg: OrbConfig = { tz: s.tz, open: s.open, close: s.close, rangeMinutes: p.range_minutes ?? 60, entryWindowMinutes: p.entry_window_minutes ?? 240, smaDays: p.sma_days ?? 20, maxDays: p.max_days ?? 5 };
        const [m5, h1] = await Promise.all([mt.candles(accountId, symbol, "5m", 300), mt.candles(accountId, symbol, "1h", 1000)]);
        const setup = orbSetup(now, toBars(m5), toBars(h1), cfg);
        const held = positions.filter((x) => x.symbol === symbol).map((x) => ({
          position_ref: x.position_ref, local_days_held: localDayDiff(Date.parse(x.opened_at), now, s.tz), max_days: cfg.maxDays,
        }));
        out[symbol] = { orb60: setup, positions: held };
      } catch (err) {
        out[symbol] = { orb60_error: (err as Error).message };
      }
    }
  }
  if (params.zones) {
    const p = params.zones;
    for (const [symbol, s] of Object.entries(p.symbols)) {
      try {
        const cfg: ZoneConfig = { tz: s.tz, pivot: p.pivot ?? 5, lookDays: p.look_days ?? 80, widthFrac: (p.width_pct ?? 0.2) / 100, minReactions: p.min_reactions ?? 5, trendSma: p.trend_sma ?? 200, maxDays: p.max_days ?? 3, tfMinutes: 240, maxZones: 10 };
        const [h4, d1] = await Promise.all([mt.candles(accountId, symbol, "4h", 1000), mt.candles(accountId, symbol, "1d", 320)]);
        const setup = zoneSetup(now, toBars(h4), toBars(d1), cfg);
        const held = positions.filter((x) => x.symbol === symbol).map((x) => ({
          position_ref: x.position_ref, local_days_held: localDayDiff(Date.parse(x.opened_at), now, s.tz), exit_after_local_days: cfg.maxDays,
          exit_due: localDayDiff(Date.parse(x.opened_at), now, s.tz) >= cfg.maxDays,
        }));
        const prev = (out[symbol] as Record<string, unknown> | undefined) ?? {};
        out[symbol] = { ...prev, zones_h4: setup, positions: held };
      } catch (err) {
        out[symbol] = { zones_h4_error: (err as Error).message };
      }
    }
  }
  return out;
}
