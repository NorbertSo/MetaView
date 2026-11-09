import type { Ctx } from "../context.js";
import { fetchCot } from "./cftc.js";
import { fetchForexFactory } from "./forexfactory.js";

const runners: Record<string, (ctx: Ctx) => Promise<number>> = {
  forexfactory: fetchForexFactory,
  cftc_cot: (ctx) => fetchCot(ctx),
};

/** Runs a built-in source and records success/failure on data_sources. */
export async function runSource(ctx: Ctx, code: string): Promise<{ records: number }> {
  const run = runners[code];
  if (!run) throw new Error(`source ${code} has no built-in fetcher (it is fed through the ingest API)`);
  const [src] = await ctx.sql<{ enabled: boolean }[]>`select enabled from data_sources where code = ${code}`;
  if (src && !src.enabled) return { records: 0 };
  try {
    const records = await run(ctx);
    await ctx.sql`update data_sources set last_success_at = now() where code = ${code}`;
    return { records };
  } catch (err) {
    await ctx.sql`update data_sources set last_error_at = now(), last_error = ${(err as Error).message} where code = ${code}`;
    throw err;
  }
}
