"use server";
import { createHash, randomBytes } from "node:crypto";
import { validateCron } from "@tv/core";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { num, opt, req, runAction, UserError } from "@/lib/action";
import { upsertSecret } from "@/lib/secrets";

async function setSetting(key: string, value: unknown) {
  const sql = db();
  const res = await sql`update app_settings set value = ${sql.json(value as never)} where key = ${key} returning key`;
  if (!res.length) throw new UserError(`Brak ustawienia ${key}.`);
}

export async function saveRiskGlobal(fd: FormData) {
  return runAction(fd, async () => {
    await setSetting("risk_global", {
      max_account_open_risk_pct: num(fd, "max_account_open_risk_pct", { min: 0.5, max: 50 }),
      max_currency_exposure_pct: num(fd, "max_currency_exposure_pct", { min: 0.5, max: 50 }),
      min_rr: num(fd, "min_rr", { min: 0, max: 10 }),
      max_spread_multiple: num(fd, "max_spread_multiple", { min: 1, max: 20 }),
    });
    const styles = fd.getAll("applies_to_styles").map(String).filter((s) => ["swing", "day", "event", "other"].includes(s));
    await setSetting("event_blackout", {
      minutes_before: Math.round(num(fd, "minutes_before", { min: 0, max: 240 })),
      minutes_after: Math.round(num(fd, "minutes_after", { min: 0, max: 240 })),
      importance: fd.getAll("importance").map(String).filter((s) => ["medium", "high"].includes(s)),
      applies_to_styles: styles,
    });
    return "Limity ryzyka zapisane.";
  });
}

export async function saveAnalyst(fd: FormData) {
  return runAction(fd, async () => {
    const cron = req(fd, "cron");
    const c = validateCron(cron, 30);
    if (!c.ok) throw new UserError(`Harmonogram analityka: ${c.error}`);
    const daily = req(fd, "daily_cron");
    const d = validateCron(daily, 60);
    if (!d.ok) throw new UserError(`Harmonogram raportu: ${d.error}`);
    const prev = (await db()<{ value: { prompt_version: string } }[]>`select value from app_settings where key = 'analyst'`)[0]?.value;
    await setSetting("analyst", {
      model_id: opt(fd, "model_id"),
      cron,
      valid_hours: num(fd, "valid_hours", { min: 1, max: 72 }),
      prompt_version: prev?.prompt_version ?? "analyst-v1",
    });
    await setSetting("daily_report", { cron: daily });
    return "Ustawienia analityka zapisane.";
  });
}

export async function saveTelegram(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const token = opt(fd, "bot_token");
    if (token) {
      if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new UserError("To nie wygląda na token bota Telegram (format 123456:ABC…).");
      await upsertSecret(sql, "telegram_bot_token", token);
    }
    const chat = opt(fd, "chat_id");
    if (chat && !/^-?\d+$/.test(chat)) throw new UserError("Chat ID to liczba (dla grup ujemna).");
    const level = req(fd, "notify_level");
    if (!["info", "warn", "error", "critical"].includes(level)) throw new UserError("Nieprawidłowy poziom.");
    await setSetting("telegram", { chat_id: chat, notify_trades: fd.get("notify_trades") === "on", notify_level: level });
    return "Telegram zapisany.";
  });
}

export async function toggleSource(fd: FormData) {
  return runAction(fd, async () => {
    await db()`update data_sources set enabled = not enabled where id = ${req(fd, "id")}`;
    return "Zapisano.";
  });
}

const SCOPES = ["news", "economic_events", "market_briefs", "journal"];

export async function createIngestToken(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const scopes = fd.getAll("scopes").map(String).filter((s) => SCOPES.includes(s));
    if (!scopes.length) throw new UserError("Wybierz co najmniej jeden zakres.");
    const token = `tvi_${randomBytes(24).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`insert into ingest_tokens (name, source_id, token_hash, token_prefix, scopes)
              values (${req(fd, "name")}, ${req(fd, "source_id")}, ${hash}, ${token.slice(0, 10)}, ${scopes})`;
    // Shown once via a short-lived httpOnly cookie (kept out of URLs and logs); only the hash is stored.
    (await cookies()).set("tv_new_token", token, { httpOnly: true, secure: true, sameSite: "strict", path: "/settings", maxAge: 120 });
    return "Token utworzony — skopiuj go z ramki poniżej (widoczny przez 2 minuty).";
  });
}

export async function revokeIngestToken(fd: FormData) {
  return runAction(fd, async () => {
    await db()`update ingest_tokens set revoked_at = now() where id = ${req(fd, "id")} and revoked_at is null`;
    return "Token unieważniony.";
  });
}
