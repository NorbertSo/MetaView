"use server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { num, opt, req, runAction, UserError } from "@/lib/action";

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w", "1mn"];

const Params = z.object({
  candles: z.record(z.enum(TIMEFRAMES as [string, ...string[]]), z.number().int().min(10).max(500)).optional(),
  news_hours: z.number().int().min(1).max(168).optional(),
  events_hours_ahead: z.number().int().min(1).max(336).optional(),
  event_trigger_minutes_before: z.number().int().min(1).max(120).optional(),
}).passthrough();

function list(s: string | null): string[] {
  return (s ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export async function createStrategy(fd: FormData) {
  return runAction(fd, async () => {
    const code = req(fd, "code").toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new UserError("Kod: 2–8 znaków A–Z, 0–9.");
    const style = req(fd, "style");
    if (!["swing", "day", "event", "other"].includes(style)) throw new UserError("Nieprawidłowy styl.");
    const [s] = await db()<{ id: string }[]>`
      insert into strategies (code, name, style, description) values (${code}, ${req(fd, "name")}, ${style}, ${opt(fd, "description") ?? ""}) returning id`;
    return { redirect: `/strategies/${s!.id}`, msg: "Strategia utworzona. Dodaj pierwszą wersję reguł." };
  });
}

export async function updateStrategy(fd: FormData) {
  return runAction(fd, async () => {
    const id = req(fd, "id");
    const status = req(fd, "status");
    if (!["draft", "active", "paused", "retired"].includes(status)) throw new UserError("Nieprawidłowy status.");
    await db()`update strategies set name = ${req(fd, "name")}, description = ${opt(fd, "description") ?? ""}, status = ${status} where id = ${id}`;
    return "Zapisano.";
  });
}

export async function saveVersion(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const strategyId = req(fd, "strategy_id");
    const versionId = opt(fd, "version_id");
    const rules = req(fd, "rules_md");
    const prompt = req(fd, "system_prompt");
    let params: unknown;
    try { params = JSON.parse(opt(fd, "params") ?? "{}"); } catch { throw new UserError("Parametry muszą być poprawnym JSON."); }
    const p = Params.safeParse(params);
    if (!p.success) throw new UserError(`Parametry: ${p.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    const timeframes = list(opt(fd, "timeframes"));
    const bad = timeframes.filter((t) => !TIMEFRAMES.includes(t));
    if (bad.length) throw new UserError(`Nieznane interwały: ${bad.join(", ")} (dozwolone: ${TIMEFRAMES.join(", ")}).`);
    const instruments = [...new Set(list(opt(fd, "instruments")))];
    if (!instruments.length) throw new UserError("Podaj co najmniej jeden instrument.");
    const hash = createHash("sha256").update(JSON.stringify({ rules, prompt, params: p.data, timeframes, instruments })).digest("hex");
    const note = opt(fd, "change_note") ?? "";

    if (versionId) {
      await sql`update strategy_versions set rules_md = ${rules}, system_prompt = ${prompt}, params = ${sql.json(p.data as never)},
                timeframes = ${timeframes}, instruments = ${instruments}, content_hash = ${hash}, change_note = ${note}
                where id = ${versionId} and approved_at is null`;
      return "Szkic wersji zapisany.";
    }
    const [v] = await sql<{ version: number }[]>`
      insert into strategy_versions (strategy_id, version, rules_md, system_prompt, params, timeframes, instruments, content_hash, change_note)
      values (${strategyId}, (select coalesce(max(version), 0) + 1 from strategy_versions where strategy_id = ${strategyId}),
              ${rules}, ${prompt}, ${sql.json(p.data as never)}, ${timeframes}, ${instruments}, ${hash}, ${note})
      returning version`;
    return `Utworzono szkic wersji v${v!.version}.`;
  });
}

export async function approveVersion(fd: FormData) {
  return runAction(fd, async () => {
    const id = req(fd, "version_id");
    if (fd.get("confirm") !== "on") throw new UserError("Zaznacz potwierdzenie — zatwierdzonej wersji nie można zmienić.");
    const sql = db();
    const [v] = await sql<{ strategy_id: string }[]>`update strategy_versions set approved_at = now() where id = ${id} and approved_at is null returning strategy_id`;
    if (!v) throw new UserError("Wersja jest już zatwierdzona albo nie istnieje.");
    await sql`update strategies set status = 'active' where id = ${v.strategy_id} and status = 'draft'`;
    return "Wersja zatwierdzona i zamrożona. Można na niej uruchamiać agentów.";
  });
}

export async function deleteDraftVersion(fd: FormData) {
  return runAction(fd, async () => {
    await db()`delete from strategy_versions where id = ${req(fd, "version_id")} and approved_at is null`;
    return "Szkic usunięty.";
  });
}

export async function saveCriteria(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const strategyId = req(fd, "strategy_id");
    const supersedes = opt(fd, "supersedes_id");
    const maxBrier = num(fd, "max_brier", { min: 0.01, max: 1, optional: true });
    const values = {
      strategy_id: strategyId,
      min_period_days: Math.round(num(fd, "min_period_days", { min: 1, max: 730 })),
      min_trades: Math.round(num(fd, "min_trades", { min: 1, max: 10_000 })),
      min_expectancy_r: num(fd, "min_expectancy_r", { min: -5, max: 10 }),
      max_drawdown_pct: num(fd, "max_drawdown_pct", { min: 0.1, max: 100 }),
      min_profit_factor: num(fd, "min_profit_factor", { min: 0.01, max: 20 }),
      max_brier: Number.isNaN(maxBrier) ? null : maxBrier,
      notes: opt(fd, "notes") ?? "",
      rationale: opt(fd, "rationale") ?? "",
      supersedes_id: supersedes,
    };
    await sql.begin(async (tx) => {
      await tx`insert into success_criteria ${tx(values)}`;
      if (supersedes) {
        await tx`insert into manual_overrides (kind, reason, details) values ('change_criteria', ${values.rationale || "zmiana kryteriów"},
                 ${tx.json({ strategy_id: strategyId, supersedes_id: supersedes } as never)})`;
      }
    });
    return supersedes ? "Zmiana zapisana — wejdzie w życie za 7 dni." : "Kryteria zapisane i zablokowane.";
  });
}
