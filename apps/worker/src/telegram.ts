import type { Ctx } from "./context.js";
import { getSecret, hasSecret } from "./secrets.js";
import { getSetting } from "./settings.js";

const API = "https://api.telegram.org";

async function tgCall<T>(token: string, method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  return json.result as T;
}

/** Sends an HTML message to the configured chat. Silently no-ops when Telegram isn't configured. */
export async function notify(ctx: Ctx, html: string): Promise<boolean> {
  const tg = await getSetting(ctx, "telegram");
  if (tg.chat_id === null || !(await hasSecret(ctx, "telegram_bot_token"))) return false;
  const token = await getSecret(ctx, "telegram_bot_token");
  // Telegram limit is 4096 chars per message.
  const text = html.length > 4000 ? `${html.slice(0, 3990)}…` : html;
  await tgCall(token, "sendMessage", { chat_id: tg.chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });
  return true;
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { id: number } };
}

/**
 * Long-polls Telegram for commands from the configured chat only:
 *   /status          — agents and account summary
 *   /note <text>     — journal entry
 *   /urge <text>     — "urge to intervene" journal entry (logged, nothing is changed)
 */
export async function pollTelegram(ctx: Ctx, onStatus: () => Promise<string>): Promise<void> {
  let offset = 0;
  while (!ctx.stopping.value) {
    try {
      const tg = await getSetting(ctx, "telegram");
      if (tg.chat_id === null || !(await hasSecret(ctx, "telegram_bot_token"))) {
        await sleep(60_000);
        continue;
      }
      const token = await getSecret(ctx, "telegram_bot_token");
      const updates = await tgCall<Update[]>(token, "getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 60_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text || String(msg.chat.id) !== String(tg.chat_id)) continue;
        const [cmd, ...rest] = msg.text.trim().split(/\s+/);
        const body = rest.join(" ").trim();
        let reply: string;
        if (cmd === "/status") {
          reply = await onStatus();
        } else if ((cmd === "/note" || cmd === "/urge") && body.length > 0) {
          await ctx.sql`insert into journal_entries (kind, body, via) values (${cmd === "/urge" ? "urge_to_intervene" : "note"}, ${body}, 'telegram')`;
          reply = cmd === "/urge"
            ? "Zapisane. Nic nie zostało zmienione — agent działa dalej według reguł."
            : "Notatka zapisana w dzienniku.";
        } else {
          reply = "Komendy: /status, /note &lt;tekst&gt;, /urge &lt;tekst&gt;";
        }
        await tgCall(token, "sendMessage", { chat_id: tg.chat_id, text: reply, parse_mode: "HTML" });
      }
    } catch (err) {
      ctx.log.warn({ err }, "telegram polling error");
      await sleep(15_000);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
