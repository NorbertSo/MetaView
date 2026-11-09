"use server";
import { db } from "@/lib/db";
import { req, runAction, UserError } from "@/lib/action";
import { sealSecret, upsertSecret } from "@/lib/secrets";

export async function setMetaApiToken(fd: FormData) {
  return runAction(fd, async () => {
    const token = req(fd, "token");
    if (token.length < 100) throw new UserError("To nie wygląda na token MetaApi (powinien być długim JWT).");
    await upsertSecret(db(), "metaapi_token", token);
    return "Token MetaApi zapisany.";
  });
}

export async function addAccount(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const name = req(fd, "name");
    const login = req(fd, "login");
    const server = req(fd, "server");
    const password = req(fd, "password");
    const platform = req(fd, "platform");
    if (!/^\d{3,15}$/.test(login)) throw new UserError("Login MT to numer konta (same cyfry).");
    if (platform !== "mt5" && platform !== "mt4") throw new UserError("Nieprawidłowa platforma.");
    const [tok] = await sql`select 1 from secrets where name = 'metaapi_token'`;
    if (!tok) throw new UserError("Najpierw zapisz token MetaApi.");
    // The broker password is sealed for the worker, used once to create the MetaApi account, then removed from the queue.
    await sql.begin(async (tx) => {
      const [acc] = await tx<{ id: string }[]>`
        insert into mt_accounts (name, login, server, platform, status) values (${name}, ${login}, ${server}, ${platform}, 'pending') returning id`;
      await tx`insert into commands (kind, payload) values ('deploy_account', ${tx.json({ mt_account_id: acc!.id, password_sealed: sealSecret(password) } as never)})`;
    });
    return "Konto dodane. Łączenie z MetaApi trwa zwykle 1–3 minuty.";
  });
}

export async function redeployAccount(fd: FormData) {
  return runAction(fd, async () => {
    const id = req(fd, "id");
    const sql = db();
    const [acc] = await sql<{ metaapi_account_id: string | null }[]>`select metaapi_account_id from mt_accounts where id = ${id}`;
    if (!acc) throw new UserError("Konto nie istnieje.");
    const payload: Record<string, unknown> = { mt_account_id: id };
    if (!acc.metaapi_account_id) {
      const password = req(fd, "password");
      payload.password_sealed = sealSecret(password);
    }
    await sql`insert into commands (kind, payload) values ('deploy_account', ${sql.json(payload as never)})`;
    return "Ponowne łączenie zlecone.";
  });
}

export async function archiveAccount(fd: FormData) {
  return runAction(fd, async () => {
    const id = req(fd, "id");
    const sql = db();
    const [a] = await sql<{ n: number }[]>`select count(*)::int as n from agents where mt_account_id = ${id} and status in ('active','paused')`;
    if (a?.n) throw new UserError("Do konta są przypisani aktywni lub wstrzymani agenci.");
    const [acc] = await sql<{ status: string }[]>`select status from mt_accounts where id = ${id}`;
    if (acc && !["undeployed", "error", "pending"].includes(acc.status)) throw new UserError("Najpierw odłącz konto od MetaApi (Odłącz).");
    await sql`update mt_accounts set status = 'archived' where id = ${id}`;
    return "Konto zarchiwizowane.";
  });
}

export async function resolveIssue(fd: FormData) {
  return runAction(fd, async () => {
    const id = req(fd, "id");
    const note = req(fd, "resolution");
    await db()`update reconciliation_issues set resolved_at = now(), resolution = ${note} where id = ${id} and resolved_at is null`;
    return "Oznaczono jako rozwiązane.";
  });
}
