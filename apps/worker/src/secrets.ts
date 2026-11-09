import { open } from "@tv/core/crypto";
import type { Ctx } from "./context.js";

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`secret "${name}" is not configured (set it in the dashboard)`);
  }
}

export async function getSecret(ctx: Ctx, name: string): Promise<string> {
  const [row] = await ctx.sql<{ ciphertext: string }[]>`select ciphertext from secrets where name = ${name}`;
  if (!row) throw new MissingSecretError(name);
  return open(row.ciphertext, ctx.privateKey);
}

export async function getSecretById(ctx: Ctx, id: string): Promise<string> {
  const [row] = await ctx.sql<{ ciphertext: string; name: string }[]>`select ciphertext, name from secrets where id = ${id}`;
  if (!row) throw new MissingSecretError(id);
  return open(row.ciphertext, ctx.privateKey);
}

export async function hasSecret(ctx: Ctx, name: string): Promise<boolean> {
  const [row] = await ctx.sql`select 1 from secrets where name = ${name}`;
  return !!row;
}

export function decryptSealed(ctx: Ctx, sealed: string): string {
  return open(sealed, ctx.privateKey);
}
