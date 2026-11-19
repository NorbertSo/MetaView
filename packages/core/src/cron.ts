import { Cron } from "croner";

/** Optional "TZ=Area/City " prefix selects the time zone of the cron fields (default UTC). */
export function parseCronTz(raw: string): { expr: string; timezone: string } {
  const m = raw.trim().match(/^TZ=(\S+)\s+(.*)$/);
  return m ? { expr: m[2]!.trim(), timezone: m[1]! } : { expr: raw.trim(), timezone: "UTC" };
}

/** Validates a 5-field cron expression (optionally "TZ=Europe/Berlin ...") and enforces a minimum interval between runs. */
export function validateCron(raw: string, minIntervalMinutes = 5): { ok: true; next: Date[] } | { ok: false; error: string } {
  const { expr, timezone } = parseCronTz(raw);
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: "cron must have exactly 5 fields (min hour dom month dow)" };
  try {
    const c = new Cron(expr, { paused: true, timezone });
    const next = c.nextRuns(6);
    c.stop();
    if (next.length === 0) return { ok: false, error: "cron never fires" };
    for (let i = 1; i < next.length; i++) {
      const gap = (next[i]!.getTime() - next[i - 1]!.getTime()) / 60_000;
      if (gap < minIntervalMinutes) return { ok: false, error: `runs more often than every ${minIntervalMinutes} min` };
    }
    return { ok: true, next };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
