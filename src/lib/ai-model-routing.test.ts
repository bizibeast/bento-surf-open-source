import { describe, expect, it, vi } from "vitest";
import { runAiJson, selectedAiModel } from "./ai-json.server";
import { approvedAiPricePolicy } from "./ai-pricing";
import { z } from "zod";

describe("value model routing", () => {
  it.each([
    [{ AI: { run: vi.fn() }, OPENROUTER_API_KEY: "key" }, "openrouter", "z-ai/glm-5.3-flash"],
    [{ OPENROUTER_API_KEY: "key" }, "openrouter", "z-ai/glm-5.3-flash"],
    [{ GROQ_API_KEY: "key" }, "groq", "openai/gpt-oss-120b"],
  ] as const)("selects a capable model within the available provider", (env, provider, model) => {
    expect(selectedAiModel(env, { modelTier: "balanced" })).toEqual({ provider, model });
    const price = approvedAiPricePolicy(provider, model);
    expect(price.input).toBeLessThanOrEqual(0.35);
    expect(price.output).toBeLessThanOrEqual(0.75);
  });

  it("uses the selected value model for OpenRouter and retains small standalone Workers mode", () => {
    expect(selectedAiModel({ AI: { run: vi.fn() } }).model).toBe("@cf/openai/gpt-oss-20b");
    expect(selectedAiModel({ OPENROUTER_API_KEY: "key" }).model).toBe("z-ai/glm-5.3-flash");
  });

  it("passes the selected tier through JSON generation with bounded reasoning", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: '{"answer":"ready"}' }) };
    await runAiJson(
      {
        system: "Answer",
        input: {},
        schema: z.object({ answer: z.string() }),
        temperature: 0,
        maxTokens: 1500,
        modelTier: "balanced",
      },
      { AI: ai },
    );
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/openai/gpt-oss-120b",
      expect.objectContaining({ max_tokens: 1500, reasoning: { effort: "low" } }),
      undefined,
    );
  });

  it("refuses the former premium model", () => {
    expect(() => approvedAiPricePolicy("openrouter", "anthropic/claude-sonnet-4.5")).toThrow(
      /approved cost/,
    );
  });
});
