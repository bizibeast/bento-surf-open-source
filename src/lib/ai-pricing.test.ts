import { describe, expect, it } from "vitest";
import { aiResponseMicrousd, approvedAiPricePolicy } from "./ai-pricing";
import { aiReservationMicrousd } from "./provider-budget.server";

describe("AI price ceilings and successful usage", () => {
  const workers = approvedAiPricePolicy("workers-ai", "@cf/openai/gpt-oss-20b");
  const sonnet = { input: 3, output: 15 }; // Historical comparison only; no longer allowlisted.

  it("reserves the selected model's full bound instead of charging all models at Sonnet rates", () => {
    const messages = [{ role: "user", content: "A".repeat(10_000) }];
    expect(aiReservationMicrousd(messages, 3000, workers)).toBeLessThan(4000);
    expect(aiReservationMicrousd(messages, 3000, sonnet)).toBeGreaterThan(75_000);
    expect(() => approvedAiPricePolicy("openrouter", "unapproved/model")).toThrow(/approved cost/);
  });

  it("uses explicit OpenRouter cost including caching discounts, rounded upward", () => {
    expect(
      aiResponseMicrousd(
        { usage: { cost: 0.0012345, prompt_tokens: 1000, completion_tokens: 500 } },
        "openrouter",
        sonnet,
      ),
    ).toBe(1235);
    expect(aiResponseMicrousd({ usage: { cost: 0 } }, "openrouter", sonnet)).toBe(0);
  });

  it("reconciles Workers AI and Groq using complete provider token usage", () => {
    expect(
      aiResponseMicrousd(
        { usage: { input_tokens: 1000, output_tokens: 100 } },
        "workers-ai",
        workers,
      ),
    ).toBe(230);
    const groq = approvedAiPricePolicy("groq", "openai/gpt-oss-20b");
    expect(
      aiResponseMicrousd({ usage: { prompt_tokens: 1000, completion_tokens: 100 } }, "groq", groq),
    ).toBe(105);
  });

  it("keeps the maximum when usage is missing, incomplete or invalid", () => {
    for (const usage of [
      undefined,
      {},
      { input_tokens: 100 },
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: "100", output_tokens: 1 },
      { input_tokens: 0, output_tokens: 0 },
      { cost: null },
      { cost: -1 },
    ]) {
      expect(aiResponseMicrousd({ usage }, "openrouter", sonnet)).toBeNull();
    }
  });
});
