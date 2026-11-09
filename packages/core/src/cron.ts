import { Cron } from "croner";

/** Validates a 5-field cron expression and enforces a minimum interval between runs. */
export function validateCron(expr: string, minIntervalMinutes = 5): { ok: true; next: Date[] } | { ok: false; error: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: "cron must have exactly 5 fields (min hour dom month dow)" };
  try {
    const c = new Cron(expr, { paused: true, timezone: "UTC" });
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
