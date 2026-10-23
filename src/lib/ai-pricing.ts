/** USD per million tokens is numerically equal to micro-USD per token.
 * Verified against provider model catalogs on 2026-10-22. Update these ceilings
 * and OpenRouter's max_price constraint together when changing models.
 */
export type AiPricePolicy = { input: number; output: number };

const AI_PRICE_POLICIES: Record<string, AiPricePolicy> = {
  "workers-ai:@cf/openai/gpt-oss-20b": { input: 0.2, output: 0.3 },
  "workers-ai:@cf/openai/gpt-oss-120b": { input: 0.35, output: 0.75 },
  "groq:openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "groq:openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  // Routing ceilings allow eligible private endpoints; actual provider cost settles below them.
  "openrouter:openai/gpt-oss-20b": { input: 0.075, output: 0.3 },
  "openrouter:openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  "openrouter:z-ai/glm-5.3-flash": { input: 0.15, output: 0.5 },
};

export function approvedAiPricePolicy(provider: string, model: string): AiPricePolicy {
  const policy = AI_PRICE_POLICIES[`${provider}:${model}`];
  if (!policy) throw new Error("This AI model has no approved cost policy.");
  return policy;
}

/** Missing or invalid usage is never interpreted as a free request. */
export function aiResponseMicrousd(
  response: unknown,
  provider: string,
  policy: AiPricePolicy,
): number | null {
  if (!response || typeof response !== "object") return null;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const values = usage as Record<string, unknown>;
  if (
    provider === "openrouter" &&
    typeof values.cost === "number" &&
    Number.isFinite(values.cost) &&
    values.cost >= 0
  )
    return Math.ceil(values.cost * 1_000_000);
  const input = values.input_tokens ?? values.prompt_tokens;
  const output = values.output_tokens ?? values.completion_tokens;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0 ||
    input + output === 0
  )
    return null;
  return Math.ceil(input * policy.input + output * policy.output);
}
