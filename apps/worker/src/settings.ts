import { z } from "zod";
import type { Ctx } from "./context.js";

export const SettingsSchema = {
  trading_enabled: z.boolean(),
  telegram: z.object({
    chat_id: z.union([z.string(), z.number()]).nullable(),
    notify_trades: z.boolean(),
    notify_level: z.enum(["info", "warn", "error", "critical"]),
  }),
  risk_global: z.object({
    max_account_open_risk_pct: z.number().positive(),
    max_currency_exposure_pct: z.number().positive(),
    min_rr: z.number().nonnegative(),
    max_spread_multiple: z.number().positive(),
  }),
  event_blackout: z.object({
    minutes_before: z.number().int().nonnegative(),
    minutes_after: z.number().int().nonnegative(),
    importance: z.array(z.string()),
    applies_to_styles: z.array(z.string()),
  }),
  analyst: z.object({
    model_id: z.string().uuid().nullable(),
    cron: z.string(),
    valid_hours: z.number().positive(),
    prompt_version: z.string(),
  }),
  daily_report: z.object({ cron: z.string() }),
  retention_days: z.object({
    heartbeats: z.number().int().positive(),
    spread_samples: z.number().int().positive(),
    llm_payloads: z.number().int().positive(),
  }),
} as const;

export type SettingKey = keyof typeof SettingsSchema;
export type Setting<K extends SettingKey> = z.infer<(typeof SettingsSchema)[K]>;

export async function getSetting<K extends SettingKey>(ctx: Ctx, key: K): Promise<Setting<K>> {
  const [row] = await ctx.sql<{ value: unknown }[]>`select value from app_settings where key = ${key}`;
  if (!row) throw new Error(`setting ${key} missing`);
  const parsed = SettingsSchema[key].safeParse(row.value);
  if (!parsed.success) throw new Error(`setting ${key} invalid: ${parsed.error.message}`);
  return parsed.data as Setting<K>;
}
