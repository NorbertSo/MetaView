import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { llmCostUsd } from "@tv/core";
import type { Ctx } from "../context.js";
import { getSecretById } from "../secrets.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  modelId: string;           // llm_models.id
  purpose: "decision" | "brief" | "review" | "test";
  agentId?: string | null;
  system: string;
  user: string;
  tool?: ToolSpec;           // when set, the model must answer by calling this tool
  temperature?: number;
  maxOutputTokens?: number;
}

export interface LlmResult {
  callId: string;
  toolInput: unknown | null; // parsed tool arguments when a tool was requested
  text: string;
  stopReason: string | null;
  costUsd: number;
}

interface ModelRow {
  id: string; model_key: string; provider_id: string; max_output_tokens: number;
  input_usd_per_mtok: number; output_usd_per_mtok: number; cache_read_usd_per_mtok: number; cache_write_usd_per_mtok: number;
  kind: "anthropic" | "minimax" | "openrouter" | "openai_compatible"; base_url: string | null;
  api_key_secret_id: string | null; provider_enabled: boolean; model_enabled: boolean; provider_name: string;
}

interface RawOutcome {
  toolInput: unknown | null;
  text: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  response: unknown;
}

export class LlmError extends Error {
  constructor(message: string, readonly callId: string | null) { super(message); }
}

const TIMEOUT_MS = 180_000;

async function loadModel(ctx: Ctx, modelId: string): Promise<ModelRow> {
  const [m] = await ctx.sql<ModelRow[]>`
    select m.id, m.model_key, m.provider_id, m.max_output_tokens, m.input_usd_per_mtok, m.output_usd_per_mtok,
           m.cache_read_usd_per_mtok, m.cache_write_usd_per_mtok, m.enabled as model_enabled,
           p.kind, p.base_url, p.api_key_secret_id, p.enabled as provider_enabled, p.name as provider_name
    from llm_models m join llm_providers p on p.id = m.provider_id where m.id = ${modelId}`;
  if (!m) throw new LlmError(`model ${modelId} not found`, null);
  if (!m.model_enabled || !m.provider_enabled) throw new LlmError(`model ${m.model_key} or provider ${m.provider_name} is disabled`, null);
  if (!m.api_key_secret_id) throw new LlmError(`provider ${m.provider_name} has no API key`, null);
  return m;
}

async function callAnthropicCompatible(m: ModelRow, apiKey: string, req: LlmRequest, nudge: boolean): Promise<RawOutcome> {
  const client = new Anthropic({ apiKey, baseURL: m.base_url ?? undefined, timeout: TIMEOUT_MS, maxRetries: 2 });
  const cacheable = m.kind === "anthropic";
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: req.system, ...(cacheable ? { cache_control: { type: "ephemeral" as const } } : {}) },
  ];
  const userText = nudge && req.tool
    ? `${req.user}\n\nIMPORTANT: respond ONLY by calling the tool "${req.tool.name}".`
    : req.user;
  const resp = await client.messages.create({
    model: m.model_key,
    max_tokens: Math.min(req.maxOutputTokens ?? m.max_output_tokens, m.max_output_tokens),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    system,
    messages: [{ role: "user", content: userText }],
    ...(req.tool ? {
      tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.inputSchema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "auto" as const },
    } : {}),
  });
  const toolBlock = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === req.tool?.name);
  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
  const u = resp.usage as Anthropic.Usage & { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  return {
    toolInput: toolBlock ? toolBlock.input : null,
    text,
    stopReason: resp.stop_reason ?? null,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    },
    response: resp,
  };
}

async function callOpenAiCompatible(m: ModelRow, apiKey: string, req: LlmRequest, nudge: boolean): Promise<RawOutcome> {
  const client = new OpenAI({ apiKey, baseURL: m.base_url ?? undefined, timeout: TIMEOUT_MS, maxRetries: 2 });
  const userText = nudge && req.tool ? `${req.user}\n\nIMPORTANT: respond ONLY by calling the function "${req.tool.name}".` : req.user;
  const resp = await client.chat.completions.create({
    model: m.model_key,
    max_tokens: Math.min(req.maxOutputTokens ?? m.max_output_tokens, m.max_output_tokens),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    messages: [{ role: "system", content: req.system }, { role: "user", content: userText }],
    ...(req.tool ? {
      tools: [{ type: "function" as const, function: { name: req.tool.name, description: req.tool.description, parameters: req.tool.inputSchema } }],
      tool_choice: "auto" as const,
    } : {}),
  });
  const choice = resp.choices[0];
  const call = choice?.message.tool_calls?.find((c) => c.type === "function" && c.function.name === req.tool?.name);
  let toolInput: unknown | null = null;
  if (call) {
    try { toolInput = JSON.parse(call.function.arguments); } catch { toolInput = null; }
  }
  const cached = (resp.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)?.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = resp.usage?.prompt_tokens ?? 0;
  return {
    toolInput,
    text: choice?.message.content ?? "",
    stopReason: choice?.finish_reason ?? null,
    usage: { inputTokens: Math.max(0, prompt - cached), outputTokens: resp.usage?.completion_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 },
    response: resp,
  };
}

/**
 * Calls a model and records the call (tokens, cost, latency, payloads) in llm_calls.
 * When a tool is requested and the model answers in prose, it retries once with a nudge.
 */
export async function callModel(ctx: Ctx, req: LlmRequest): Promise<LlmResult> {
  const m = await loadModel(ctx, req.modelId);
  const apiKey = await getSecretById(ctx, m.api_key_secret_id!);
  const attempts = req.tool ? 2 : 1;
  let lastCallId: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const started = new Date();
    let outcome: RawOutcome | null = null;
    let error: string | null = null;
    try {
      outcome = m.kind === "anthropic" || m.kind === "minimax"
        ? await callAnthropicCompatible(m, apiKey, req, attempt > 0)
        : await callOpenAiCompatible(m, apiKey, req, attempt > 0);
    } catch (err) {
      error = (err as Error).message;
    }
    const finished = new Date();
    const usage = outcome?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = llmCostUsd(m, usage);
    const missingTool = !!req.tool && !!outcome && outcome.toolInput === null;
    const status = error ? (/timeout|timed out/i.test(error) ? "timeout" : "error") : missingTool ? "invalid_output" : "ok";

    const [row] = await ctx.sql<{ id: string }[]>`
      insert into llm_calls (purpose, agent_id, provider_id, model_id, model_key, started_at, finished_at, latency_ms,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, status,
                             stop_reason, error, request, response)
      values (${req.purpose}, ${req.agentId ?? null}, ${m.provider_id}, ${m.id}, ${m.model_key}, ${started}, ${finished},
              ${finished.getTime() - started.getTime()}, ${usage.inputTokens}, ${usage.outputTokens}, ${usage.cacheReadTokens},
              ${usage.cacheWriteTokens}, ${cost}, ${status}, ${outcome?.stopReason ?? null},
              ${error ?? (missingTool ? "model did not call the required tool" : null)},
              ${ctx.sql.json({ system: req.system, user: req.user, tool: req.tool?.name ?? null, attempt } as never)},
              ${outcome ? ctx.sql.json(JSON.parse(JSON.stringify(outcome.response)) as never) : null})
      returning id`;
    lastCallId = row!.id;

    if (error) throw new LlmError(`${m.provider_name}/${m.model_key}: ${error}`, lastCallId);
    if (!missingTool) {
      return { callId: lastCallId, toolInput: outcome!.toolInput, text: outcome!.text, stopReason: outcome!.stopReason, costUsd: cost };
    }
  }
  throw new LlmError("model did not call the required tool after a retry", lastCallId);
}
