import { expect, it } from "vitest";
import { BENNY_EDITING_MODELS, bennyModelSelection } from "./benny-models";
import { approvedAiPricePolicy } from "./ai-pricing";

it("offers Astra and every interactive Gemini 4 with an enforced reservation ceiling", () => {
  const expected = [
    ["openai/gpt-6.2-astra", "GPT 6.2 Astra", 20, 60],
    ["google/gemini-4-hydrogen", "Gemini 4 Hydrogen", 1.5, 7.5],
    ["google/gemini-4-carbon", "Gemini 4 Carbon", 2, 10],
    ["google/gemini-4-argon", "Gemini 4 Argon", 2, 10],
    ["google/gemini-4-neon", "Gemini 4 Neon", 3, 15],
  ] as const;
  const selection = bennyModelSelection({
    bentoModels: [...BENNY_EDITING_MODELS],
    providers: [],
    defaultProviderId: null,
  });
  for (const [id, label, input, output] of expected) {
    expect(selection.options).toContainEqual({
      value: `bento|${id}`,
      label,
      ...(["google/gemini-4-carbon", "google/gemini-4-neon"].includes(id)
        ? { disabled: true }
        : {}),
    });
    expect(approvedAiPricePolicy("openrouter", id)).toEqual({ input, output });
  }
  expect(new Set(BENNY_EDITING_MODELS.map((m) => m.id)).size).toBe(BENNY_EDITING_MODELS.length);
});
