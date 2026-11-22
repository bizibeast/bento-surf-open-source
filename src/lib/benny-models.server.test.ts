import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BENNY_EDITING_MODELS, bennyModelSelection } from "./benny-models";
import { withBennyEditingModel } from "./benny-models.server";
import { runAiJson, selectedAiModel } from "./ai-json.server";
import {
  ProviderBudgetError,
  reserveAiProviderUsage,
  settleProviderUsage,
  withManagedProviderBudget,
} from "./provider-budget.server";

const scope = { workspaceId: "workspace-a", authUserId: "owner-a" };
const request = {
  system: "Return JSON.",
  input: {},
  schema: z.object({ answer: z.string() }),
  maxTokens: 100,
  temperature: 0.4,
  modelTier: "balanced" as const,
};
const env = {
  OPENROUTER_API_KEY: "fixture-key",
  AI_TEXT_PROVIDER: "workers-ai" as const,
  AI: { run: vi.fn() },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("managed editing models", () => {
  it.each(BENNY_EDITING_MODELS.filter((model) => model.available))(
    "routes $name exactly, retaining bounded metering",
    async (model) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          choices: [{ message: { content: '{"answer":"ready"}' } }],
          usage: { cost: 0.001 },
        }),
      );
      await withManagedProviderBudget(scope, () =>
        withBennyEditingModel(model.id, () => runAiJson(request, env, fetcher)),
      );
      const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        model: model.id,
        max_tokens: 100,
        reasoning: { effort: "low" },
        provider: {
          sort: "price",
          data_collection: "deny",
          allow_fallbacks: false,
          require_parameters: true,
          max_price: { prompt: model.price.input, completion: model.price.output },
        },
      });
      expect(body).not.toHaveProperty("temperature");
      expect(body.provider).not.toHaveProperty("zdr");
      expect(env.AI.run).not.toHaveBeenCalled();
      expect(reserveAiProviderUsage).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({ provider: "openrouter", model: model.id }),
      );
      expect(vi.mocked(reserveAiProviderUsage).mock.invocationCallOrder[0]).toBeLessThan(
        fetcher.mock.invocationCallOrder[0],
      );
      expect(settleProviderUsage).toHaveBeenCalledWith(undefined, 1000);
      expect(selectedAiModel({ OPENROUTER_API_KEY: "fixture-key" }).model).toBe(
        "z-ai/glm-5.3-flash",
      );
    },
  );

  it("refuses Store/Creator or arbitrary model requests before running work", () => {
    const work = vi.fn();
    expect(() => withBennyEditingModel(BENNY_EDITING_MODELS[0].id, work)).toThrow(/Creator\+/);
    expect(() =>
      withManagedProviderBudget(scope, () => withBennyEditingModel("arbitrary/paid-model", work)),
    ).toThrow(/unavailable/);
    expect(work).not.toHaveBeenCalled();
  });

  it("never falls back when the managed key is absent", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      withManagedProviderBudget(scope, () =>
        withBennyEditingModel(BENNY_EDITING_MODELS[0].id, () =>
          runAiJson(request, { AI: env.AI }, fetcher),
        ),
      ),
    ).rejects.toThrow(/unavailable/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(reserveAiProviderUsage).not.toHaveBeenCalled();
  });

  it("makes no premium request when the verified subscription or allowance is denied", async () => {
    vi.mocked(reserveAiProviderUsage).mockRejectedValueOnce(
      new ProviderBudgetError("ai_microusd", { reason: "ineligible" }),
    );
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      withManagedProviderBudget(scope, () =>
        withBennyEditingModel(BENNY_EDITING_MODELS[2].id, () => runAiJson(request, env, fetcher)),
      ),
    ).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("isolates overlapping model selections and restores the outer selection", async () => {
    const results = await Promise.all(
      BENNY_EDITING_MODELS.filter((model) => model.available).map((model) =>
        withManagedProviderBudget(scope, () =>
          withBennyEditingModel(model.id, async () => {
            await Promise.resolve();
            return selectedAiModel(env).model;
          }),
        ),
      ),
    );
    expect(results).toEqual(
      BENNY_EDITING_MODELS.filter((model) => model.available).map((model) => model.id),
    );
    expect(selectedAiModel({ OPENROUTER_API_KEY: "fixture-key" }).model).toBe("z-ai/glm-5.3-flash");
    expect(() =>
      withManagedProviderBudget(scope, () =>
        withManagedProviderBudget({ workspaceId: "workspace-b", authUserId: "owner-b" }, () => {}),
      ),
    ).toThrow(ProviderBudgetError);
  });

  it("does not grant premium access from a forged picker value or change own-key billing", () => {
    const settings = {
      bentoModels: [],
      defaultProviderId: "saved-provider",
      providers: [
        {
          id: "saved-provider",
          model: BENNY_EDITING_MODELS[0].id,
          additional_models: [BENNY_EDITING_MODELS[1].id],
        },
      ],
    };
    expect(bennyModelSelection(settings, `bento|${BENNY_EDITING_MODELS[0].id}`).valid).toBe(false);
    const own = bennyModelSelection(settings, `saved-provider|${BENNY_EDITING_MODELS[1].id}`);
    expect(own.input).toEqual({
      aiProviderId: "saved-provider",
      aiModel: BENNY_EDITING_MODELS[1].id,
    });
    expect(own.options[1].label).toBe("GPT 6.2 Sol · Your key");
  });
});

it.each(BENNY_EDITING_MODELS.filter((model) => !model.available))(
  "rejects the unavailable $name route before any paid request",
  (model) => {
    const work = vi.fn();
    expect(() =>
      withManagedProviderBudget(scope, () => withBennyEditingModel(model.id, work)),
    ).toThrow(/unavailable/);
    expect(work).not.toHaveBeenCalled();
    expect(reserveAiProviderUsage).not.toHaveBeenCalled();
  },
);
