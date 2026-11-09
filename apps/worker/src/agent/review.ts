import { z } from "zod";
import type { Ctx } from "../context.js";
import { callModel } from "../llm/client.js";

const ReviewOut = z.object({
  thesis_held: z.boolean().nullable(),
  process_quality: z.number().int().min(1).max(5),
  what_worked: z.string().max(2000),
  what_failed: z.string().max(2000),
  lesson_candidate: z.string().max(600).nullable(),
  tags: z.array(z.string().min(1).max(48)).max(10),
});

const reviewSchema = {
  type: "object", additionalProperties: false,
  required: ["thesis_held", "process_quality", "what_worked", "what_failed", "lesson_candidate", "tags"],
  properties: {
    thesis_held: { type: ["boolean", "null"], description: "Did the original thesis play out (independent of P&L)? null if unclear." },
    process_quality: { type: "integer", minimum: 1, maximum: 5, description: "How well the decision followed the strategy rules, regardless of outcome." },
    what_worked: { type: "string" },
    what_failed: { type: "string" },
    lesson_candidate: { type: ["string", "null"], description: "One generalizable, testable lesson, or null. Do not generalize from noise." },
    tags: { type: "array", items: { type: "string" }, description: "snake_case tags describing the situation (e.g. pre_event_entry, trend_d1_up)." },
  },
} as const;

/** Post-trade review by the same model that made the trade. Lessons are only candidates; a human approves them. */
export async function reviewTrade(ctx: Ctx, tradeId: string): Promise<void> {
  const [t] = await ctx.sql<{
    id: string; agent_id: string; model_id: string; rules_md: string; symbol: string; direction: string; entry_price: number;
    exit_price: number | null; initial_sl: number; initial_tp: number | null; net_pnl: number; r_multiple: number | null;
    exit_reason: string | null; opened_at: Date; closed_at: Date | null; mae_price: number | null; mfe_price: number | null;
    rationale: string | null; probability: number | null; status: string;
  }[]>`
    select t.id, t.agent_id, a.model_id, v.rules_md, t.symbol, t.direction, t.entry_price, t.exit_price, t.initial_sl, t.initial_tp,
           t.net_pnl, t.r_multiple, t.exit_reason, t.opened_at, t.closed_at, t.mae_price, t.mfe_price, d.rationale, d.probability, t.status
    from trades t join agents a on a.id = t.agent_id join strategy_versions v on v.id = a.strategy_version_id
    left join decisions d on d.id = t.open_decision_id
    where t.id = ${tradeId}`;
  if (!t || t.status !== "closed") return;
  const [exists] = await ctx.sql`select 1 from trade_reviews where trade_id = ${tradeId}`;
  if (exists) return;

  const events = await ctx.sql<{ occurred_at: Date; kind: string; old_value: unknown; new_value: unknown; price: number | null }[]>`
    select occurred_at, kind, old_value, new_value, price from position_events where trade_id = ${tradeId} order by occurred_at`;

  const res = await callModel(ctx, {
    modelId: t.model_id, purpose: "review", agentId: t.agent_id,
    system: "You review a closed trade made by an automated agent. Judge the PROCESS against the strategy rules, not just the result. " +
      "A losing trade can be a good decision and a winning one a bad decision. Propose a lesson only if it is general and testable. " +
      "Answer only via the submit_review tool.\n\nSTRATEGY RULES:\n" + t.rules_md,
    user: JSON.stringify({
      trade: {
        symbol: t.symbol, direction: t.direction, entry: t.entry_price, exit: t.exit_price, initial_sl: t.initial_sl, initial_tp: t.initial_tp,
        net_pnl: t.net_pnl, r_multiple: t.r_multiple, exit_reason: t.exit_reason, opened_at: t.opened_at, closed_at: t.closed_at,
        worst_price: t.mae_price, best_price: t.mfe_price, stated_probability: t.probability, original_rationale: t.rationale,
      },
      position_events: events,
    }),
    tool: { name: "submit_review", description: "Submit the trade review.", inputSchema: reviewSchema as unknown as Record<string, unknown> },
    temperature: 0.2,
    maxOutputTokens: 2000,
  });
  const out = ReviewOut.parse(res.toolInput);
  await ctx.sql`
    insert into trade_reviews (trade_id, agent_id, llm_call_id, thesis_held, process_quality, what_worked, what_failed, lesson_candidate, tags)
    values (${t.id}, ${t.agent_id}, ${res.callId}, ${out.thesis_held}, ${out.process_quality}, ${out.what_worked}, ${out.what_failed},
            ${out.lesson_candidate}, ${out.tags})
    on conflict (trade_id) do nothing`;
}
