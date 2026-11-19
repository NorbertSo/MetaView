/**
 * Precomputed setups for the agent, ported 1:1 from the research backtests
 * (lab2 ORB60 "C3", lab3 zones v2). Pure functions over candle arrays.
 */

export interface Bar { t: number; o: number; h: number; l: number; c: number } // t = bar OPEN time, ms UTC

// ---------------------------------------------------------------------------
// Time zone helpers (no dependencies)
// ---------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Local calendar date (YYYY-MM-DD) and minutes after local midnight. */
export function localParts(ms: number, tz: string): { date: string; minutes: number; dow: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, minutes: Number(p.hour) * 60 + Number(p.minute), dow };
}

/** UTC ms of local wall time `hh:mm` on local date `date` in `tz`. */
export function zonedToUtc(date: string, hhmm: string, tz: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const lp = localParts(t, tz);
    const localAsUtc = Date.parse(`${lp.date}T00:00:00Z`) + lp.minutes * 60_000;
    t += guess - localAsUtc;
  }
  return t;
}

/** Whole local calendar days between two instants (b - a). */
export function localDayDiff(a: number, b: number, tz: string): number {
  const da = Date.parse(`${localParts(a, tz).date}T00:00:00Z`);
  const db = Date.parse(`${localParts(b, tz).date}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

const r2 = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const sma = (xs: number[], n: number) => (xs.length >= n ? xs.slice(-n).reduce((s, x) => s + x, 0) / n : null);

// ---------------------------------------------------------------------------
// Sessions (regular trading hours) built from intraday bars
// ---------------------------------------------------------------------------

export interface Session { date: string; open: number; high: number; low: number; close: number; start: number; end: number }

/** Groups intraday bars whose open falls in [open, close) local time into daily RTH sessions. */
export function rthSessions(bars: Bar[], tz: string, open: string, close: string): Session[] {
  const [oh, om] = open.split(":").map(Number); const [ch, cm] = close.split(":").map(Number);
  const o = oh! * 60 + om!, c = ch! * 60 + cm!;
  const out: Session[] = [];
  for (const b of bars) {
    const lp = localParts(b.t, tz);
    if (lp.dow === 0 || lp.dow === 6 || lp.minutes < o || lp.minutes >= c) continue;
    const s = out[out.length - 1];
    if (!s || s.date !== lp.date) out.push({ date: lp.date, open: b.o, high: b.h, low: b.l, close: b.c, start: b.t, end: b.t });
    else { s.high = Math.max(s.high, b.h); s.low = Math.min(s.low, b.l); s.close = b.c; s.end = b.t; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ORB60 "C3"
// ---------------------------------------------------------------------------

export interface OrbConfig { tz: string; open: string; close: string; rangeMinutes: number; entryWindowMinutes: number; smaDays: number; maxDays: number }

export interface OrbSetup {
  strategy: "ORB60";
  session_date: string; session_open_utc: string; session_close_utc: string;
  status: "before_open" | "range_forming" | "entry_window" | "window_closed" | "closed_day";
  trend_d1: "up" | "down" | "flat" | "unknown"; sma: number | null; last_session_close: number | null;
  yesterday_nr7: boolean | null;
  range_high: number | null; range_low: number | null; range_points: number | null;
  touched_high_after_range: boolean; touched_low_after_range: boolean;
  first_touch_after_range: "high" | "low" | "both_same_bar" | null;
  daily_atr: number | null;
  entry_window_end_utc: string; minutes_left_in_window: number;
  rule_verdict: string;
  suggested_order: null | { entry_type: "stop"; direction: "long" | "short"; entry_price: number; stop_loss: number; expiry_minutes: number };
  trailing_levels: { h1_low3: number | null; h1_high3: number | null; d1_low3: number | null; d1_high3: number | null };
}

/**
 * m5: recent 5-minute bars (>= today's session), h1: ~1000 hourly bars (>= 30 sessions).
 * Daily trend and NR7 use RTH sessions rebuilt from H1 bars (the backtest used RTH sessions).
 */
export function orbSetup(now: number, m5: Bar[], h1: Bar[], cfg: OrbConfig): OrbSetup {
  const today = localParts(now, cfg.tz);
  const openUtc = zonedToUtc(today.date, cfg.open, cfg.tz);
  const closeUtc = zonedToUtc(today.date, cfg.close, cfg.tz);
  const rangeEnd = openUtc + cfg.rangeMinutes * 60_000;
  const windowEnd = rangeEnd + cfg.entryWindowMinutes * 60_000;

  const sessions = rthSessions(h1, cfg.tz, cfg.open, cfg.close).filter((s) => s.date < today.date);
  const closes = sessions.map((s) => s.close);
  const sm = sma(closes, cfg.smaDays);
  const last = closes.length ? closes[closes.length - 1]! : null;
  const trend: OrbSetup["trend_d1"] = sm === null || last === null ? "unknown" : last > sm ? "up" : last < sm ? "down" : "flat";
  let nr7: boolean | null = null;
  if (sessions.length >= 7) {
    const rg = sessions.slice(-7).map((s) => s.high - s.low);
    nr7 = rg[6]! <= Math.min(...rg.slice(0, 6));
  }

  const todays = m5.filter((b) => b.t >= openUtc && b.t < closeUtc);
  const inRange = todays.filter((b) => b.t < rangeEnd);
  const after = todays.filter((b) => b.t >= rangeEnd);
  const rangeDone = now >= rangeEnd && inRange.length > 0;
  const hi = rangeDone ? Math.max(...inRange.map((b) => b.h)) : null;
  const lo = rangeDone ? Math.min(...inRange.map((b) => b.l)) : null;
  const touchedHi = hi !== null && after.some((b) => b.h >= hi);
  const touchedLo = lo !== null && after.some((b) => b.l <= lo);
  let firstTouch: OrbSetup["first_touch_after_range"] = null;
  if (hi !== null && lo !== null) {
    for (const b of after) {
      const u = b.h >= hi, d = b.l <= lo;
      if (u && d) { firstTouch = "both_same_bar"; break; }
      if (u) { firstTouch = "high"; break; }
      if (d) { firstTouch = "low"; break; }
    }
  }
  // Daily ATR(14) of RTH sessions known before today (backtest: skip when range < 0.1 ATR).
  let datr: number | null = null;
  if (sessions.length >= 6) {
    const tr = sessions.slice(1).map((s, i) => Math.max(s.high - s.low, Math.abs(s.high - sessions[i]!.close), Math.abs(s.low - sessions[i]!.close)));
    const lastTr = tr.slice(-14);
    datr = lastTr.reduce((x, y) => x + y, 0) / lastTr.length;
  }

  const weekend = today.dow === 0 || today.dow === 6;
  let status: OrbSetup["status"] = weekend ? "closed_day" : now < openUtc ? "before_open" : now < rangeEnd ? "range_forming" : now < windowEnd ? "entry_window" : "window_closed";
  if (status === "entry_window" && !inRange.length) status = "closed_day"; // holiday: no bars

  const minutesLeft = Math.max(0, Math.floor((windowEnd - now) / 60_000));
  let verdict = "";
  let suggested: OrbSetup["suggested_order"] = null;
  if (status !== "entry_window") verdict = `no entry now (${status})`;
  else if (nr7) verdict = "skip: previous session was NR7 (rule: no trade the day after NR7)";
  else if (trend !== "up" && trend !== "down") verdict = "skip: daily trend unknown/flat";
  else if (datr !== null && hi !== null && lo !== null && hi - lo < 0.1 * datr) verdict = "skip: opening range smaller than 0.1 x daily ATR";
  else {
    const long = trend === "up";
    const triggered = long ? touchedHi : touchedLo;
    const against = firstTouch === "both_same_bar" || (long ? firstTouch === "low" : firstTouch === "high");
    if (against) verdict = "skip/cancel: the first breakout after the range went AGAINST the trend (backtest rule: no trade that day); cancel any pending ORB order";
    else if (triggered) verdict = `trend-side edge already touched after the range (${long ? "high" : "low"}); the backtested entry would already be filled`;
    else {
      verdict = `rule entry: ${long ? "buy stop at range high" : "sell stop at range low"}, SL at the opposite side, valid ${minutesLeft} min`;
      suggested = { entry_type: "stop", direction: long ? "long" : "short", entry_price: long ? hi! : lo!, stop_loss: long ? lo! : hi!, expiry_minutes: Math.max(5, minutesLeft) };
    }
  }

  const doneH1 = h1.filter((b) => b.t + 3_600_000 <= now).slice(-3);
  const doneD1 = sessions.slice(-3);
  return {
    strategy: "ORB60", session_date: today.date, session_open_utc: new Date(openUtc).toISOString(), session_close_utc: new Date(closeUtc).toISOString(),
    status, trend_d1: trend, sma: sm === null ? null : r2(sm, 2), last_session_close: last, yesterday_nr7: nr7,
    range_high: hi, range_low: lo, range_points: hi !== null && lo !== null ? r2(hi - lo, 2) : null,
    touched_high_after_range: touchedHi, touched_low_after_range: touchedLo, first_touch_after_range: firstTouch,
    daily_atr: datr === null ? null : r2(datr, 2),
    entry_window_end_utc: new Date(windowEnd).toISOString(), minutes_left_in_window: minutesLeft,
    rule_verdict: verdict, suggested_order: suggested,
    trailing_levels: {
      h1_low3: doneH1.length === 3 ? Math.min(...doneH1.map((b) => b.l)) : null, h1_high3: doneH1.length === 3 ? Math.max(...doneH1.map((b) => b.h)) : null,
      d1_low3: doneD1.length === 3 ? Math.min(...doneD1.map((s) => s.low)) : null, d1_high3: doneD1.length === 3 ? Math.max(...doneD1.map((s) => s.high)) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Zones v2 (H4): clusters of swing highs AND lows, breakout + add on retest
// ---------------------------------------------------------------------------

export interface ZoneConfig { tz: string; pivot: number; lookDays: number; widthFrac: number; minReactions: number; trendSma: number; maxDays: number; tfMinutes: number; maxZones: number }
export interface Zone { low: number; high: number; reactions: number }

/** Pivot highs/lows (centered window 2k+1); confirmation index = i + k. Same as research pivots(). */
export function pivots(bars: Bar[], k: number): { conf: number; price: number; type: 1 | -1 }[] {
  const out: { conf: number; price: number; type: 1 | -1; i: number }[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let lo = true, hi = true;
    for (let j = i - k; j <= i + k; j++) {
      if (bars[j]!.l < bars[i]!.l) lo = false;
      if (bars[j]!.h > bars[i]!.h) hi = false;
    }
    if (lo) out.push({ conf: i + k, price: bars[i]!.l, type: -1, i });
    if (hi) out.push({ conf: i + k, price: bars[i]!.h, type: 1, i });
  }
  // research: lows first then highs, stable-sorted by confirmation index
  out.sort((a, b) => a.conf - b.conf || (a.type - b.type));
  return out.map(({ conf, price, type }) => ({ conf, price, type }));
}

/** Greedy densest non-overlapping clusters of pivots confirmed in [b0 - lookBars, b0). Port of _zones_daily. */
export function clusterZones(piv: { conf: number; price: number; type: 1 | -1 }[], b0: number, lookBars: number, wfrac: number, nmin: number, maxz: number): Zone[] {
  const sel = piv.filter((p) => p.conf >= b0 - lookBars && p.conf < b0);
  const m = sel.length;
  if (m < nmin) return [];
  const idx = sel.map((_, i) => i).sort((a, b) => sel[a]!.price - sel[b]!.price);
  const p = idx.map((i) => sel[i]!.price), ty = idx.map((i) => sel[i]!.type);
  const used = new Array<boolean>(m).fill(false);
  const W = wfrac * p[Math.floor(m / 2)]!;
  const zones: Zone[] = [];
  while (zones.length < maxz) {
    let best = -1, bc = 0, bj = 0, j = 0;
    for (let i = 0; i < m; i++) {
      if (used[i]) continue;
      if (j < i) j = i;
      while (j + 1 < m && p[j + 1]! - p[i]! <= W && !used[j + 1]) j++;
      const cnt = j - i + 1;
      if (cnt > bc) {
        let hh = false, ll = false;
        for (let q = i; q <= j; q++) { if (ty[q]! > 0) hh = true; else ll = true; }
        if (!(hh && ll)) continue;
        bc = cnt; best = i; bj = j;
      }
    }
    if (best < 0 || bc < nmin) break;
    const cen = 0.5 * (p[best]! + p[bj]!);
    zones.push({ low: cen - W / 2, high: cen + W / 2, reactions: bc });
    for (let q = best; q <= bj; q++) used[q] = true;
    for (let q = 0; q < m; q++) if (p[q]! >= cen - W && p[q]! <= cen + W) used[q] = true;
  }
  return zones;
}

export interface ZoneSetup {
  strategy: "STREFY_H4";
  trend_d1_sma: "up" | "down" | "unknown"; sma: number | null; last_daily_close: number | null;
  zones: { low: number; high: number; reactions: number; position: "above" | "below" | "inside" }[];
  last_closed_bar: { open_utc: string; close_utc: string; close: number; prev_close: number } | null;
  signal: null | { direction: "long" | "short"; zone_low: number; zone_high: number; rule_entry: "market now (next H4 open)"; stop_loss: number; add_on_retest: { entry_type: "limit"; entry_price: number } };
  rule_verdict: string;
  bars_since_signal_bar_close_min: number | null;
}

/**
 * h4: broker H4 bars (>= lookDays + some), d1: daily bars (>= trendSma + 1).
 * Zones are those of the current local day: pivots confirmed before the day's first H4 bar.
 */
export function zoneSetup(now: number, h4: Bar[], d1: Bar[], cfg: ZoneConfig): ZoneSetup {
  const tfMs = cfg.tfMinutes * 60_000;
  const done = h4.filter((b) => b.t + tfMs <= now);
  const piv = pivots(done, cfg.pivot);
  const last = done[done.length - 1], prev = done[done.length - 2];
  // Day of the last closed bar (exchange-local date of its open): zones known at that day's first bar.
  const refDay = last ? localParts(last.t, cfg.tz).date : localParts(now, cfg.tz).date;
  let b0 = done.findIndex((b) => localParts(b.t, cfg.tz).date === refDay);
  if (b0 < 0) b0 = done.length;
  const lookBars = Math.floor(cfg.lookDays * (1440 / cfg.tfMinutes) * 0.9);
  const zones = clusterZones(piv, b0, lookBars, cfg.widthFrac, cfg.minReactions, cfg.maxZones);

  // Daily trend known at the last bar's open: daily closes of days completed before that bar.
  const dDone = d1.filter((b) => last ? b.t + 86_400_000 <= last.t + 1 : b.t + 86_400_000 <= now);
  const closes = dDone.map((b) => b.c);
  const sm = sma(closes, cfg.trendSma);
  const lc = closes.length ? closes[closes.length - 1]! : null;
  const trend = sm === null || lc === null ? "unknown" : lc > sm ? "up" : lc < sm ? "down" : "unknown";

  let signal: ZoneSetup["signal"] = null;
  let verdict = "no breakout on the last closed H4 bar";
  if (last && prev) {
    for (const z of zones) {
      const up = prev.c <= z.high && last.c > z.high;
      const dn = prev.c >= z.low && last.c < z.low;
      if (up && trend === "up") {
        signal = { direction: "long", zone_low: z.low, zone_high: z.high, rule_entry: "market now (next H4 open)", stop_loss: z.low, add_on_retest: { entry_type: "limit", entry_price: z.high } };
        break;
      }
      if (dn && trend === "down") {
        signal = { direction: "short", zone_low: z.low, zone_high: z.high, rule_entry: "market now (next H4 open)", stop_loss: z.high, add_on_retest: { entry_type: "limit", entry_price: z.low } };
        break;
      }
      if (up || dn) { verdict = `breakout ${up ? "up" : "down"} through zone ${r2(z.low, 2)}–${r2(z.high, 2)} but against the daily SMA${cfg.trendSma} trend (${trend}): no entry`; break; }
    }
    if (signal) verdict = `rule entry: ${signal.direction} at market, SL ${r2(signal.stop_loss, 2)} (other side of the zone), add a second unit with a limit at ${r2(signal.add_on_retest.entry_price, 2)} if price returns to the zone, exit after ${cfg.maxDays} local days`;
  }
  const px = last?.c ?? 0;
  return {
    strategy: "STREFY_H4", trend_d1_sma: trend, sma: sm === null ? null : r2(sm, 2), last_daily_close: lc,
    zones: zones.map((z) => ({ low: r2(z.low, 2), high: r2(z.high, 2), reactions: z.reactions, position: (px > z.high ? "below" : px < z.low ? "above" : "inside") as "above" | "below" | "inside" }))
      .sort((a, b) => a.low - b.low),
    last_closed_bar: last && prev ? { open_utc: new Date(last.t).toISOString(), close_utc: new Date(last.t + tfMs).toISOString(), close: last.c, prev_close: prev.c } : null,
    signal: signal ? { ...signal, zone_low: r2(signal.zone_low, 2), zone_high: r2(signal.zone_high, 2), stop_loss: r2(signal.stop_loss, 2), add_on_retest: { entry_type: "limit", entry_price: r2(signal.add_on_retest.entry_price, 2) } } : null,
    rule_verdict: verdict,
    bars_since_signal_bar_close_min: last ? Math.round((now - (last.t + tfMs)) / 60_000) : null,
  };
}
