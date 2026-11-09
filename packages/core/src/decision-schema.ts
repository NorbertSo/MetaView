import { z } from "zod";

export const ACTIONS = ["open_long", "open_short", "modify_position", "add", "partial_close", "close", "hold", "skip"] as const;

/**
 * What the model must return through the `submit_decisions` tool.
 * Volume is deliberately absent: position size is always computed in code.
 */
export const ModelDecision = z
  .object({
    action: z.enum(ACTIONS),
    symbol: z.string().min(1).max(32).nullable(),
    position_ref: z.string().max(64).nullable().describe("Trade reference from context for modify/add/close"),
    probability: z.number().min(0).max(1).nullable(),
    stop_loss: z.number().positive().nullable(),
    take_profit: z.number().positive().nullable(),
    close_fraction: z.number().gt(0).lte(1).nullable(),
    expected_r: z.number().min(-10).max(50).nullable(),
    rationale: z.string().min(10).max(4000),
    factors: z.array(z.string().min(1).max(64)).max(12),
  })
  .superRefine((d, ctx) => {
    const need = (cond: boolean, msg: string) => { if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg }); };
    if (d.action === "open_long" || d.action === "open_short" || d.action === "add") {
      need(d.symbol !== null, `${d.action} requires symbol`);
      need(d.probability !== null, `${d.action} requires probability`);
      need(d.stop_loss !== null, `${d.action} requires stop_loss`);
    }
    if (d.action === "modify_position") {
      need(d.position_ref !== null, "modify_position requires position_ref");
      need(d.stop_loss !== null || d.take_profit !== null, "modify_position requires a new stop_loss and/or take_profit");
    }
    if (d.action === "add" || d.action === "close" || d.action === "partial_close") {
      need(d.position_ref !== null, `${d.action} requires position_ref`);
    }
    if (d.action === "partial_close") need(d.close_fraction !== null && d.close_fraction < 1, "partial_close requires close_fraction < 1");
  });
export type ModelDecision = z.infer<typeof ModelDecision>;

export const ModelDecisionBatch = z.object({
  market_view: z.string().min(10).max(4000),
  decisions: z.array(ModelDecision).min(1).max(12),
});
export type ModelDecisionBatch = z.infer<typeof ModelDecisionBatch>;

/** JSON schema handed to the model as the tool input schema. Kept in sync with the zod schema above. */
export const submitDecisionsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["market_view", "decisions"],
  properties: {
    market_view: { type: "string", description: "Your reading of the current situation in 2-6 sentences." },
    decisions: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      description: "One entry per action. If you do nothing, return a single 'hold' (positions open) or 'skip' (no positions) with the reason.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "symbol", "position_ref", "probability", "stop_loss", "take_profit", "close_fraction", "expected_r", "rationale", "factors"],
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          symbol: { type: ["string", "null"], description: "Broker symbol exactly as in context." },
          position_ref: { type: ["string", "null"], description: "Required for modify_position, add, partial_close, close: the position_ref from context." },
          probability: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Probability that the trade reaches its target before its stop. Required for open/add. Be calibrated." },
          stop_loss: { type: ["number", "null"], description: "Absolute price. Required for open/add; for modify_position the new SL." },
          take_profit: { type: ["number", "null"], description: "Absolute price or null." },
          close_fraction: { type: ["number", "null"], description: "For partial_close: fraction of current volume to close, 0 < x < 1." },
          expected_r: { type: ["number", "null"], description: "Expected outcome in R multiples." },
          rationale: { type: "string", description: "Why, referring to the strategy rules and the data in context." },
          factors: { type: "array", items: { type: "string" }, maxItems: 12, description: "Short snake_case tags of the key factors." },
        },
      },
    },
  },
} as const;
