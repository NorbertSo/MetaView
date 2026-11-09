import type { Ctx } from "./context.js";
import { systemEvent } from "./events.js";
import { callModel } from "./llm/client.js";
import type { MetaApiManager } from "./metaapi/manager.js";
import { refreshSpec } from "./metaapi/instruments.js";
import { decryptSealed } from "./secrets.js";
import { runAgent } from "./agent/runner.js";
import { reviewTrade } from "./agent/review.js";
import { generateBrief } from "./analyst/brief.js";
import { closeAllForAgent, closeTrade } from "./trading/execution.js";
import { notify } from "./telegram.js";
import { runSource } from "./sources/index.js";

interface Command { id: string; kind: string; payload: Record<string, unknown> }

type Handler = (ctx: Ctx, mt: MetaApiManager, p: Record<string, unknown>) => Promise<unknown>;

const str = (p: Record<string, unknown>, k: string): string => {
  const v = p[k];
  if (typeof v !== "string" || !v) throw new Error(`payload.${k} is required`);
  return v;
};

const handlers: Record<string, Handler> = {
  async test_provider(ctx, _mt, p) {
    const providerId = str(p, "provider_id");
    const [model] = await ctx.sql<{ id: string }[]>`
      select id from llm_models where provider_id = ${providerId} and enabled order by (id = ${(p.model_id as string) ?? null}) desc, created_at limit 1`;
    if (!model) throw new Error("provider has no enabled model");
    try {
      const r = await callModel(ctx, { modelId: model.id, purpose: "test", system: "You are a connectivity check.", user: "Reply with the single word OK.", maxOutputTokens: 20 });
      await ctx.sql`update llm_providers set status = 'ok', last_tested_at = now(), last_error = null where id = ${providerId}`;
      return { reply: r.text.slice(0, 100), cost_usd: r.costUsd };
    } catch (err) {
      await ctx.sql`update llm_providers set status = 'error', last_tested_at = now(), last_error = ${(err as Error).message} where id = ${providerId}`;
      throw err;
    }
  },

  async deploy_account(ctx, mt, p) {
    const accId = str(p, "mt_account_id");
    const [acc] = await ctx.sql<{ id: string; name: string; login: string; server: string; platform: "mt4" | "mt5"; metaapi_account_id: string | null }[]>`
      select id, name, login, server, platform, metaapi_account_id from mt_accounts where id = ${accId}`;
    if (!acc) throw new Error("account not found");
    await ctx.sql`update mt_accounts set status = 'deploying', last_error = null where id = ${accId}`;
    let metaId = acc.metaapi_account_id;
    if (!metaId) {
      const password = decryptSealed(ctx, str(p, "password_sealed"));
      metaId = (await mt.createAccount({ name: acc.name, login: acc.login, password, server: acc.server, platform: acc.platform })).id;
      await ctx.sql`update mt_accounts set metaapi_account_id = ${metaId} where id = ${accId}`;
    }
    const account = await mt.getAccount(metaId);
    if (account.state !== "DEPLOYED") await account.deploy();
    await account.waitConnected(300);
    await ctx.sql`update mt_accounts set status = 'connected' where id = ${accId}`;
    await systemEvent(ctx, "info", "accounts", "account_deployed", `${acc.name} połączone z MetaApi`, { mtAccountId: accId });
    return { metaapi_account_id: metaId };
  },

  async undeploy_account(ctx, mt, p) {
    const accId = str(p, "mt_account_id");
    const [acc] = await ctx.sql<{ metaapi_account_id: string | null }[]>`select metaapi_account_id from mt_accounts where id = ${accId}`;
    if (!acc?.metaapi_account_id) throw new Error("account not deployed");
    const [open] = await ctx.sql<{ n: number }[]>`select count(*)::int as n from trades where mt_account_id = ${accId} and status = 'open'`;
    if (open?.n) throw new Error(`account has ${open.n} open trades; close them first`);
    mt.invalidate(acc.metaapi_account_id);
    await (await mt.getAccount(acc.metaapi_account_id)).undeploy();
    await ctx.sql`update mt_accounts set status = 'undeployed' where id = ${accId}`;
    return { ok: true };
  },

  async refresh_account(ctx, mt, p) {
    const accId = str(p, "mt_account_id");
    const [acc] = await ctx.sql<{ metaapi_account_id: string | null }[]>`select metaapi_account_id from mt_accounts where id = ${accId}`;
    if (!acc?.metaapi_account_id) throw new Error("account not deployed");
    mt.invalidate(acc.metaapi_account_id);
    const info = await mt.accountInformation(acc.metaapi_account_id);
    return { balance: info.balance, equity: info.equity, currency: info.currency, type: info.type, margin_mode: info.marginMode };
  },

  async sync_instruments(ctx, mt, p) {
    const accId = str(p, "mt_account_id");
    const symbols = Array.isArray(p.symbols) ? (p.symbols as string[]) : [];
    const [acc] = await ctx.sql<{ id: string; metaapi_account_id: string | null; server: string }[]>`select id, metaapi_account_id, server from mt_accounts where id = ${accId}`;
    if (!acc?.metaapi_account_id) throw new Error("account not deployed");
    const ref = { id: acc.id, metaapi_account_id: acc.metaapi_account_id, server: acc.server };
    const list = symbols.length ? symbols : await mt.symbols(acc.metaapi_account_id);
    const failed: string[] = [];
    let ok = 0;
    for (const s of list.slice(0, 400)) {
      try { await refreshSpec(ctx, mt, ref, s); ok++; } catch { failed.push(s); }
    }
    return { synced: ok, failed };
  },

  async run_agent(ctx, mt, p) {
    return runAgent(ctx, mt, str(p, "agent_id"), "manual");
  },

  async review_trade(ctx, _mt, p) {
    await reviewTrade(ctx, str(p, "trade_id"));
    return { ok: true };
  },

  async close_trade(ctx, mt, p) {
    const tradeId = str(p, "trade_id");
    const [t] = await ctx.sql<{ id: string; agent_id: string; position_id: string; symbol: string; direction: "long" | "short"; volume_open: number;
      current_sl: number | null; current_tp: number | null; status: string; code: string; magic: number; acc_id: string; metaapi_account_id: string; server: string }[]>`
      select t.id, t.agent_id, t.position_id, t.symbol, t.direction, t.volume_open, t.current_sl, t.current_tp, t.status,
             a.code, a.magic, m.id as acc_id, m.metaapi_account_id, m.server
      from trades t join agents a on a.id = t.agent_id join mt_accounts m on m.id = t.mt_account_id where t.id = ${tradeId}`;
    if (!t || t.status !== "open") throw new Error("trade is not open");
    const res = await closeTrade(ctx, mt, { id: t.acc_id, metaapi_account_id: t.metaapi_account_id, server: t.server },
      { id: t.agent_id, code: t.code, magic: t.magic }, null, t, 1, "manual");
    if (!res.ok) throw new Error(res.error);
    return res;
  },

  async close_agent_positions(ctx, mt, p) {
    return closeAllForAgent(ctx, mt, str(p, "agent_id"), "manual");
  },

  async kill_agent(ctx, mt, p) {
    const agentId = str(p, "agent_id");
    await ctx.sql`update agents set status = 'killed', status_reason = ${(p.reason as string) ?? "manual kill"} where id = ${agentId} and status in ('active','paused')`;
    return closeAllForAgent(ctx, mt, agentId, "manual");
  },

  async generate_brief(ctx) {
    return { brief_id: await generateBrief(ctx) };
  },

  async fetch_source(ctx, _mt, p) {
    return runSource(ctx, str(p, "code"));
  },

  async send_test_telegram(ctx) {
    const sent = await notify(ctx, "✅ Trading 2.2: powiadomienia działają.");
    if (!sent) throw new Error("Telegram is not configured (bot token and chat id required)");
    return { sent };
  },
};

/** Processes queued commands. FOR UPDATE SKIP LOCKED makes it safe with several workers. */
export async function drainCommands(ctx: Ctx, mt: MetaApiManager): Promise<void> {
  for (;;) {
    if (ctx.stopping.value) return;
    const [cmd] = await ctx.sql<Command[]>`
      update commands set status = 'running', started_at = now()
      where id = (select id from commands where status = 'queued' order by created_at limit 1 for update skip locked)
      returning id, kind, payload`;
    if (!cmd) return;
    const handler = handlers[cmd.kind];
    try {
      if (!handler) throw new Error(`unknown command ${cmd.kind}`);
      const result = await handler(ctx, mt, cmd.payload ?? {});
      await ctx.sql`update commands set status = 'done', result = ${ctx.sql.json((result ?? null) as never)}, finished_at = now(),
                    payload = payload - 'password_sealed' where id = ${cmd.id}`;
    } catch (err) {
      const message = (err as Error).message;
      await ctx.sql`update commands set status = 'error', error = ${message}, finished_at = now(), payload = payload - 'password_sealed' where id = ${cmd.id}`;
      if (cmd.kind === "deploy_account" && typeof cmd.payload.mt_account_id === "string") {
        await ctx.sql`update mt_accounts set status = 'error', last_error = ${message} where id = ${cmd.payload.mt_account_id}`;
      }
      ctx.log.warn({ kind: cmd.kind, err: message }, "command failed");
    }
  }
}

/** Fails commands left 'running' by a crashed process (they never resume half-way). */
export async function recoverStuckCommands(ctx: Ctx): Promise<void> {
  await ctx.sql`update commands set status = 'error', error = 'worker restarted while running', finished_at = now(),
                payload = payload - 'password_sealed'
                where status = 'running' and started_at < now() - interval '10 minutes'`;
  await ctx.sql`update agent_runs set status = 'error', error = 'worker restarted during run', finished_at = now()
                where status = 'running' and started_at < now() - interval '15 minutes'`;
}
