"use server";
import { db } from "@/lib/db";
import { req, runAction, UserError } from "@/lib/action";

async function accountEquity(): Promise<number | null> {
  const [r] = await db()<{ eq: number | null }[]>`
    select sum(equity) as eq from (select distinct on (mt_account_id) equity from account_snapshots order by mt_account_id, taken_at desc) s`;
  return r?.eq ?? null;
}

/** Global switch for opening new positions. Every change is an override with a reason. */
export async function setTradingEnabled(fd: FormData) {
  return runAction(fd, async () => {
    const enable = fd.get("enable") === "true";
    const reason = req(fd, "reason");
    const sql = db();
    if (enable) {
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from mt_accounts where status = 'connected'`;
      if (!n?.n) throw new UserError("Najpierw podłącz konto MT (Konta MT).");
    }
    await sql.begin(async (tx) => {
      await tx`update app_settings set value = ${tx.json(enable as never)} where key = 'trading_enabled'`;
      await tx`insert into manual_overrides (kind, reason, equity_at) values (${enable ? "global_resume" : "global_kill_switch"}, ${reason}, ${await accountEquity()})`;
    });
    return enable ? "Handel włączony." : "Handel wyłączony. Otwarte pozycje są dalej zarządzane przez agentów.";
  });
}

export async function setAgentStatus(fd: FormData) {
  return runAction(fd, async () => {
    const agentId = req(fd, "agent_id");
    const to = req(fd, "to") as "active" | "paused" | "archived";
    const reason = req(fd, "reason");
    if (!["active", "paused", "archived"].includes(to)) throw new UserError("Nieprawidłowy status.");
    const sql = db();
    const [a] = await sql<{ status: string; equity: number }[]>`select a.status, e.equity from agents a join v_agent_equity e on e.agent_id = a.id where a.id = ${agentId}`;
    if (!a) throw new UserError("Agent nie istnieje.");
    if (to === "archived") {
      const [o] = await sql<{ n: number }[]>`select count(*)::int as n from trades where agent_id = ${agentId} and status = 'open'`;
      if (o?.n) throw new UserError("Agent ma otwarte pozycje — najpierw je zamknij.");
    }
    await sql.begin(async (tx) => {
      await tx`update agents set status = ${to}, status_reason = ${reason} where id = ${agentId}`;
      // Activating a draft is a configuration step, not an intervention; everything else is logged as an override.
      if (!(a.status === "draft" && to === "active")) {
        await tx`insert into manual_overrides (kind, agent_id, reason, equity_at)
                 values (${to === "active" ? "resume_agent" : to === "paused" ? "pause_agent" : "other"}, ${agentId}, ${reason}, ${a.equity})`;
      }
    });
    return `Status agenta: ${to}.`;
  });
}

export async function killAgent(fd: FormData) {
  return runAction(fd, async () => {
    const agentId = req(fd, "agent_id");
    const reason = req(fd, "reason");
    if (fd.get("confirm") !== "KILL") throw new UserError("Wpisz KILL, aby potwierdzić.");
    const sql = db();
    const [a] = await sql<{ equity: number }[]>`select equity from v_agent_equity where agent_id = ${agentId}`;
    await sql.begin(async (tx) => {
      await tx`insert into manual_overrides (kind, agent_id, reason, equity_at) values ('kill_agent', ${agentId}, ${reason}, ${a?.equity ?? null})`;
      await tx`insert into commands (kind, payload) values ('kill_agent', ${tx.json({ agent_id: agentId, reason } as never)})`;
    });
    return "Agent zostanie zatrzymany, a jego pozycje zamknięte.";
  });
}

export async function closeTradeManually(fd: FormData) {
  return runAction(fd, async () => {
    const tradeId = req(fd, "trade_id");
    const reason = req(fd, "reason");
    const sql = db();
    const [t] = await sql<{ agent_id: string; status: string; equity: number }[]>`
      select t.agent_id, t.status, e.equity from trades t join v_agent_equity e on e.agent_id = t.agent_id where t.id = ${tradeId}`;
    if (!t || t.status !== "open") throw new UserError("Pozycja nie jest otwarta.");
    await sql.begin(async (tx) => {
      await tx`insert into manual_overrides (kind, agent_id, trade_id, reason, equity_at) values ('close_trade', ${t.agent_id}, ${tradeId}, ${reason}, ${t.equity})`;
      await tx`insert into commands (kind, payload) values ('close_trade', ${tx.json({ trade_id: tradeId } as never)})`;
    });
    return "Zlecenie zamknięcia wysłane.";
  });
}

export async function runAgentNow(fd: FormData) {
  return runAction(fd, async () => {
    const agentId = req(fd, "agent_id");
    const [a] = await db()<{ status: string }[]>`select status from agents where id = ${agentId}`;
    if (a?.status !== "active") throw new UserError("Ręczne uruchomienie jest możliwe tylko dla aktywnego agenta.");
    await db()`insert into commands (kind, payload) values ('run_agent', ${db().json({ agent_id: agentId } as never)})`;
    return "Uruchomienie zlecone. Wynik pojawi się w decyzjach.";
  });
}

export async function enqueueCommand(fd: FormData) {
  return runAction(fd, async () => {
    const kind = req(fd, "kind");
    const allowed = ["generate_brief", "fetch_source", "send_test_telegram", "refresh_account", "sync_instruments", "test_provider", "undeploy_account"];
    if (!allowed.includes(kind)) throw new UserError("Niedozwolona komenda.");
    const payload: Record<string, unknown> = {};
    for (const [k, v] of fd.entries()) {
      if (k.startsWith("p_") && typeof v === "string" && v) payload[k.slice(2)] = k === "p_symbols" ? v.split(/[\s,]+/).filter(Boolean) : v;
    }
    await db()`insert into commands (kind, payload) values (${kind}, ${db().json(payload as never)})`;
    return "Zlecono. Wynik w Ustawienia → Komendy.";
  });
}
