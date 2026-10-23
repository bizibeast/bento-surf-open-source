import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn() }));
vi.mock("./provider-budget.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-budget.server")>()),
  reserveAiProviderUsage: mocks.reserve,
  settleProviderUsage: mocks.settle,
}));
import { runFounderAiModelSmoke } from "./founder-ai-model-check.server";
import { ProviderBudgetError } from "./provider-budget.server";
import * as pricing from "./ai-pricing";

const env = { AI_TEXT_PROVIDER: "openrouter" as const, OPENROUTER_API_KEY: "fictional-test-key" };
const sample = {
  role: "reviewer",
  builtBy: "Rowan",
  hook: "A long task list? Here is how to pick the next three actions.",
  tip: "Choose three next actions from your task list.",
};
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(value) } }],
      usage: { cost: 0.0001 },
    }),
  );

describe("founder selected-model smoke check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserve.mockResolvedValue({ id: "reservation", units: 10000 });
    mocks.settle.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("uses exactly one budgeted request, fixed source, output cap, and no customer data", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(sample));
    const result = await runFounderAiModelSmoke(env, fetcher);
    expect(result.status).toBe("completed");
    expect(result.checks).toEqual({
      structuredOutput: true,
      reviewerAttribution: true,
      actionableTip: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.reserve.mock.calls[0][0]).toBeLessThanOrEqual(result.reservedMaximumMicrousd!);
    expect(result.reservedMaximumMicrousd).toBeLessThanOrEqual(10_000);
    const init = fetcher.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload.max_tokens).toBe(800);
    expect(payload.messages[1].content).toContain("Fictional creator Avery");
    expect(result.sample?.hook).toBe(sample.hook);
  });
  it("never calls the provider when the workspace allowance is denied", async () => {
    mocks.reserve.mockRejectedValue(new ProviderBudgetError("ai_microusd"));
    const fetcher = vi.fn(async () => response(sample));
    const result = await runFounderAiModelSmoke(env, fetcher);
    expect(result.status).toBe("budget_denied");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses before reservation if the estimate exceeds one cent", async () => {
    vi.spyOn(pricing, "approvedAiPricePolicy").mockReturnValue({ input: 100, output: 100 });
    const fetcher = vi.fn(async () => response(sample));
    const result = await runFounderAiModelSmoke(env, fetcher);
    expect(result.status).toBe("cost_limit");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports malformed output without retrying the paid request", async () => {
    const fetcher = vi.fn(async () => response({ role: "reviewer" }));
    const result = await runFounderAiModelSmoke(env, fetcher);
    expect(result.status).toBe("invalid_output");
    expect(result.sample).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.settle).toHaveBeenCalledTimes(1);
  });
  it("reports an attribution mismatch as a failed check rather than inventing a score", async () => {
    const result = await runFounderAiModelSmoke(
      env,
      vi.fn(async () => response({ ...sample, role: "builder", builtBy: "Avery" })),
    );
    expect(result.status).toBe("completed");
    expect(result.checks?.reviewerAttribution).toBe(false);
    expect(result).not.toHaveProperty("score");
  });
  it("ends within fifteen seconds and never sends a request after a late budget reservation", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    let reserve!: (value: { id: string; units: number }) => void;
    mocks.reserve.mockReturnValue(
      new Promise((resolve) => {
        reserve = resolve;
      }),
    );
    const fetcher = vi.fn(async () => response(sample));
    const pending = runFounderAiModelSmoke(env, fetcher);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).status).toBe("unavailable");
    reserve({ id: "late-reservation", units: 1000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith({ id: "late-reservation", units: 1000 }, 0);
  });
  it("honors an explicit Cloudflare route while an OpenRouter credential is present", async () => {
    const worker = {
      run: vi.fn(async () => ({
        response: JSON.stringify(sample),
        usage: { input_tokens: 100, output_tokens: 100 },
      })),
    };
    const fetcher = vi.fn(async () => response(sample));
    const result = await runFounderAiModelSmoke(
      { ...env, AI_TEXT_PROVIDER: "workers-ai", AI: worker },
      fetcher,
    );
    expect(result.status).toBe("completed");
    expect(result.model?.provider).toBe("workers-ai");
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts the recorded three-actionable-next-steps synonym without losing the count or attribution checks", async () => {
    const recorded =
      "Avery demonstrated a key feature of PocketPlan: transforming a lengthy task list into three distinct, actionable next steps.";
    const result = await runFounderAiModelSmoke(
      env,
      vi.fn(async () => response({ ...sample, tip: recorded })),
    );
    expect(result.checks).toEqual({
      structuredOutput: true,
      reviewerAttribution: true,
      actionableTip: true,
    });
    for (const tip of [
      "Three reasons to stay organized.",
      "Choose your next steps from the list.",
    ]) {
      const incomplete = await runFounderAiModelSmoke(
        env,
        vi.fn(async () => response({ ...sample, tip })),
      );
      expect(incomplete.checks?.actionableTip).toBe(false);
    }
  });
});
