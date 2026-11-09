"use server";
import { validateCron } from "@tv/core";
import { db } from "@/lib/db";
import { num, opt, req, runAction, UserError } from "@/lib/action";

function parseInstruments(raw: string | null): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

export async function createAgent(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const versionId = req(fd, "strategy_version_id");
    const [v] = await sql<{ approved_at: Date | null; instruments: string[] }[]>`select approved_at, instruments from strategy_versions where id = ${versionId}`;
    if (!v) throw new UserError("Wersja strategii nie istnieje.");
    if (!v.approved_at) throw new UserError("Agenta można utworzyć tylko na zatwierdzonej wersji strategii.");

    const instruments = parseInstruments(opt(fd, "instruments"));
    const chosen = instruments.length ? instruments : v.instruments;
    const outside = chosen.filter((s) => !v.instruments.includes(s));
    if (outside.length) throw new UserError(`Instrumenty spoza wersji strategii: ${outside.join(", ")}.`);

    const cron = req(fd, "schedule_cron");
    const c = validateCron(cron, 5);
    if (!c.ok) throw new UserError(`Harmonogram: ${c.error}`);

    const code = req(fd, "code").toUpperCase();
    if (!/^[A-Z0-9]{3,6}$/.test(code)) throw new UserError("Kod agenta: 3–6 znaków A–Z, 0–9.");

    const [m] = await sql<{ enabled: boolean; provider_enabled: boolean; has_key: boolean }[]>`
      select m.enabled, p.enabled as provider_enabled, p.api_key_secret_id is not null as has_key
      from llm_models m join llm_providers p on p.id = m.provider_id where m.id = ${req(fd, "model_id")}`;
    if (!m) throw new UserError("Model nie istnieje.");
    if (!m.enabled || !m.provider_enabled) throw new UserError("Model lub dostawca jest wyłączony.");

    const activate = fd.get("activate") === "on";
    if (activate && !m.has_key) throw new UserError("Dostawca modelu nie ma klucza API — dodaj go w Modele AI.");

    const values = {
      code,
      name: req(fd, "name"),
      strategy_version_id: versionId,
      model_id: req(fd, "model_id"),
      mt_account_id: req(fd, "mt_account_id"),
      allocated_capital: num(fd, "allocated_capital", { min: 100 }),
      risk_per_trade_pct: num(fd, "risk_per_trade_pct", { min: 0.05, max: 5 }),
      max_open_positions: Math.round(num(fd, "max_open_positions", { min: 1, max: 50 })),
      max_daily_loss_pct: num(fd, "max_daily_loss_pct", { min: 0.1, max: 50 }),
      max_drawdown_pct: num(fd, "max_drawdown_pct", { min: 1, max: 100 }),
      schedule_cron: cron,
      instruments: chosen,
      temperature: num(fd, "temperature", { min: 0, max: 1 }),
      status: activate ? "active" : "draft",
    };
    const [a] = await sql<{ id: string }[]>`insert into agents ${sql(values)} returning id`;
    return { redirect: `/agents/${a!.id}`, msg: activate ? "Agent utworzony i aktywny." : "Agent utworzony jako szkic." };
  });
}

/** Draft agents can still be edited; once activated their identity is frozen (enforced in the database). */
export async function updateDraftAgent(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const id = req(fd, "id");
    const cron = req(fd, "schedule_cron");
    const c = validateCron(cron, 5);
    if (!c.ok) throw new UserError(`Harmonogram: ${c.error}`);
    const [a] = await sql<{ activated_at: Date | null; instruments: string[] }[]>`
      select a.activated_at, v.instruments from agents a join strategy_versions v on v.id = a.strategy_version_id where a.id = ${id}`;
    if (!a) throw new UserError("Agent nie istnieje.");
    const instruments = parseInstruments(opt(fd, "instruments"));
    const outside = instruments.filter((s) => !a.instruments.includes(s));
    if (!instruments.length || outside.length) throw new UserError("Instrumenty muszą być podzbiorem instrumentów wersji strategii.");
    if (a.activated_at && !opt(fd, "reason")) throw new UserError("Agent był już aktywowany — podaj powód zmiany (zapisze się jako interwencja).");
    // Risk limits and schedule may change at any time (they tighten or relax behaviour, not attribution).
    await sql`
      update agents set name = ${req(fd, "name")}, schedule_cron = ${cron}, instruments = ${instruments},
             risk_per_trade_pct = ${num(fd, "risk_per_trade_pct", { min: 0.05, max: 5 })},
             max_open_positions = ${Math.round(num(fd, "max_open_positions", { min: 1, max: 50 }))},
             max_daily_loss_pct = ${num(fd, "max_daily_loss_pct", { min: 0.1, max: 50 })},
             max_drawdown_pct = ${num(fd, "max_drawdown_pct", { min: 1, max: 100 })},
             temperature = ${num(fd, "temperature", { min: 0, max: 1 })}
      where id = ${id}`;
    if (a.activated_at) {
      await sql`insert into manual_overrides (kind, agent_id, reason, details) values ('other', ${id}, ${req(fd, "reason")},
                ${sql.json({ change: "settings" } as never)})`;
    }
    return "Ustawienia agenta zapisane.";
  });
}
