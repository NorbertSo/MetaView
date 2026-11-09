import "server-only";
import { last4, publicKeyFromBase64, seal } from "@tv/core/crypto";
import type { Sql } from "@tv/db";
import { env } from "./env";

/** Encrypts with the public key only; the web app can never decrypt what it stores. */
export function sealSecret(plaintext: string): string {
  return seal(plaintext, publicKeyFromBase64(env().SECRETS_PUBLIC_KEY));
}

export async function upsertSecret(sql: Sql, name: string, plaintext: string): Promise<string> {
  const value = plaintext.trim();
  if (value.length < 4) throw new Error("wartość sekretu jest za krótka");
  const [row] = await sql<{ id: string }[]>`
    insert into secrets (name, ciphertext, last4) values (${name}, ${sealSecret(value)}, ${last4(value)})
    on conflict (name) do update set ciphertext = excluded.ciphertext, last4 = excluded.last4, rotated_at = now()
    returning id`;
  return row!.id;
}
