"use server";
import { db } from "@/lib/db";
import { num, opt, req, runAction, UserError } from "@/lib/action";
import { upsertSecret } from "@/lib/secrets";

const KINDS = ["anthropic", "minimax", "openrouter", "openai_compatible"] as const;

function checkUrl(u: string | null): string | null {
  if (!u) return null;
  let url: URL;
  try { url = new URL(u); } catch { throw new UserError("Nieprawidłowy adres URL."); }
  if (url.protocol !== "https:") throw new UserError("Adres API musi używać HTTPS.");
  return u.replace(/\/+$/, "");
}

export async function saveProvider(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const id = opt(fd, "id");
    const name = req(fd, "name");
    const kind = req(fd, "kind");
    if (!KINDS.includes(kind as (typeof KINDS)[number])) throw new UserError("Nieznany typ dostawcy.");
    const baseUrl = checkUrl(opt(fd, "base_url"));
    const enabled = fd.get("enabled") === "on";
    if (id) {
      await sql`update llm_providers set name = ${name}, kind = ${kind}, base_url = ${baseUrl}, enabled = ${enabled} where id = ${id}`;
    } else {
      await sql`insert into llm_providers (name, kind, base_url, enabled) values (${name}, ${kind}, ${baseUrl}, ${enabled})`;
    }
    return "Dostawca zapisany.";
  });
}

export async function setProviderKey(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const id = req(fd, "id");
    const key = req(fd, "api_key");
    const secretId = await upsertSecret(sql, `llm_provider:${id}`, key);
    await sql`update llm_providers set api_key_secret_id = ${secretId}, status = 'untested', last_error = null where id = ${id}`;
    await sql`insert into commands (kind, payload) values ('test_provider', ${sql.json({ provider_id: id } as never)})`;
    return "Klucz zapisany (zaszyfrowany). Test połączenia uruchomiony.";
  });
}

export async function testProvider(fd: FormData) {
  return runAction(fd, async () => {
    const id = req(fd, "id");
    await db()`insert into commands (kind, payload) values ('test_provider', ${db().json({ provider_id: id } as never)})`;
    return "Test uruchomiony — odśwież za kilka sekund.";
  });
}

export async function saveModel(fd: FormData) {
  return runAction(fd, async () => {
    const sql = db();
    const id = opt(fd, "id");
    const values = {
      provider_id: req(fd, "provider_id"),
      model_key: req(fd, "model_key"),
      display_name: req(fd, "display_name"),
      input_usd_per_mtok: num(fd, "input_usd_per_mtok", { min: 0 }),
      output_usd_per_mtok: num(fd, "output_usd_per_mtok", { min: 0 }),
      cache_read_usd_per_mtok: num(fd, "cache_read_usd_per_mtok", { min: 0 }),
      cache_write_usd_per_mtok: num(fd, "cache_write_usd_per_mtok", { min: 0 }),
      max_output_tokens: Math.round(num(fd, "max_output_tokens", { min: 256, max: 200_000 })),
      enabled: fd.get("enabled") === "on",
    };
    if (id) {
      // The API model id is part of an agent's identity once used; only prices/limits/name/enabled are editable then.
      const [used] = await sql<{ n: number }[]>`select count(*)::int as n from agents where model_id = ${id} and activated_at is not null`;
      const [cur] = await sql<{ model_key: string; provider_id: string }[]>`select model_key, provider_id from llm_models where id = ${id}`;
      if (used?.n && cur && (cur.model_key !== values.model_key || cur.provider_id !== values.provider_id)) {
        throw new UserError("Model jest używany przez aktywowanych agentów — nie można zmienić jego ID ani dostawcy. Dodaj nowy model.");
      }
      await sql`update llm_models set ${sql(values)} where id = ${id}`;
    } else {
      await sql`insert into llm_models ${sql(values)}`;
    }
    return "Model zapisany.";
  });
}
