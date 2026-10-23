import { z } from "zod";
import {
  AiStructuredOutputError,
  runAiJson,
  selectedAiModel,
  type AiProviderEnv,
} from "./ai-json.server";
import { approvedAiPricePolicy } from "./ai-pricing";
import { aiReservationMicrousd, ProviderBudgetError } from "./provider-budget.server";

const MAX_OUTPUT_TOKENS = 800;
const MAX_MICROUSD = 10_000;
const TIMEOUT_MS = 15_000;
const schema = z
  .object({
    role: z.enum(["reviewer", "builder", "uncertain"]),
    builtBy: z.enum(["Rowan", "Avery", "unknown"]),
    hook: z.string().min(1).max(180),
    tip: z.string().min(1).max(220),
  })
  .strict();
const system =
  "Run a fictional structured-output and attribution check. Use only the supplied source. Identify Avery's relationship to the app and its actual builder. Write an engaging curiosity-driven hook and one useful action from the source. Do not invent ownership, user numbers, revenue, or performance claims. Return JSON with role (reviewer/builder/uncertain), builtBy (Rowan/Avery/unknown), hook (at most 180 characters), and tip (at most 220 characters).";
const input = {
  source:
    "Fictional creator Avery reviewed the fictional app PocketPlan in a video. PocketPlan was built by Rowan. Avery demonstrated how to turn a long task list into three next actions. The source contains no measured results or audience numbers.",
};
const responseFormat = { type: "json_object" };

type Selection = ReturnType<typeof selectedAiModel>;
export type FounderAiModelCheck = {
  status: "completed" | "budget_denied" | "cost_limit" | "invalid_output" | "unavailable";
  checkedAt: string;
  model: Selection | null;
  reservedMaximumMicrousd: number | null;
  checks: {
    structuredOutput: boolean;
    reviewerAttribution: boolean;
    actionableTip: boolean;
  } | null;
  sample: { hook: string; tip: string } | null;
};
const safeSample = (value: string) => value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

/** Explicit founder action: one fixed fictional input, one selected model, no fallback/retry. */
export async function runFounderAiModelSmoke(
  env = ((globalThis as { __env__?: AiProviderEnv }).__env__ ?? {}) as AiProviderEnv,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<FounderAiModelCheck> {
  const result: FounderAiModelCheck = {
    status: "unavailable",
    checkedAt: new Date().toISOString(),
    model: null,
    reservedMaximumMicrousd: null,
    checks: null,
    sample: null,
  };
  try {
    result.model = selectedAiModel(env, { modelTier: "balanced" });
    const price = approvedAiPricePolicy(result.model.provider, result.model.model);
    // Include a conservative 2 KiB allowance for runAiJson's JSON protocol wrapper.
    // The regression test compares this bound with its actual budget reservation.
    result.reservedMaximumMicrousd = aiReservationMicrousd(
      { system, input, responseFormat, jsonProtocolOverhead: " ".repeat(2048) },
      MAX_OUTPUT_TOKENS,
      price,
    );
    if (
      !Number.isSafeInteger(result.reservedMaximumMicrousd) ||
      result.reservedMaximumMicrousd > MAX_MICROUSD
    )
      return { ...result, status: "cost_limit" };
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const request = runAiJson(
      {
        system,
        input,
        schema,
        responseFormat,
        modelTier: "balanced",
        reasoningEffort: "low",
        temperature: 0.2,
        maxTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: TIMEOUT_MS,
        signal,
      },
      env,
      fetcher,
    );
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const { value } = await Promise.race([request, interrupted]).finally(() => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    });
    return {
      ...result,
      status: "completed",
      checkedAt: new Date().toISOString(),
      checks: {
        structuredOutput: true,
        reviewerAttribution: value.role === "reviewer" && value.builtBy === "Rowan",
        actionableTip:
          /\b(three|3)\b/i.test(value.tip) && /\b(actions|tasks|steps)\b/i.test(value.tip),
      },
      sample: { hook: safeSample(value.hook), tip: safeSample(value.tip) },
    };
  } catch (error) {
    if (error instanceof ProviderBudgetError) return { ...result, status: "budget_denied" };
    if (
      error instanceof AiStructuredOutputError ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    )
      return { ...result, status: "invalid_output" };
    return result;
  }
}
