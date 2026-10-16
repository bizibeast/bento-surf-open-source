import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAiJson, runAiProviderRequest, selectAiProvider } from "./ai-json.server";
import { reserveProviderUsage, ProviderBudgetError } from "./provider-budget.server";

const schema = z.object({ answer: z.string().min(1).max(100) }).strict();

describe("validated AI JSON transport", () => {
  it("makes no provider call when the atomic budget reservation is denied", async () => {
    vi.mocked(reserveProviderUsage).mockRejectedValueOnce(new ProviderBudgetError("ai_microusd"));
    const ai = { run: vi.fn() };
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      runAiJson(
        { system: "Answer", input: {}, schema, maxTokens: 100, temperature: 0 },
        { AI: ai, OPENROUTER_API_KEY: "key", GROQ_API_KEY: "key" },
        fetcher,
      ),
    ).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(ai.run).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("bounds Workers AI time without spending on another provider", async () => {
    vi.useFakeTimers();
    const ai = { run: vi.fn().mockImplementation(() => new Promise(() => {})) };
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("OpenRouter down"));
    const pending = runAiJson(
      { system: "Answer.", input: {}, schema, maxTokens: 1_000, temperature: 0, timeoutMs: 100 },
      { OPENROUTER_API_KEY: "key", AI: ai, GROQ_API_KEY: "fallback" },
      fetcher,
    );
    const rejection = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels an HTTP request and avoids fallback when its caller aborts", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => {
      requestSignal = options?.signal;
      return new Promise(() => {});
    });
    const ai = { run: vi.fn() };
    const pending = runAiJson(
      {
        system: "Answer.",
        input: {},
        schema,
        maxTokens: 100,
        temperature: 0,
        signal: controller.signal,
      },
      { OPENROUTER_API_KEY: "key", AI: ai },
      fetcher,
    );
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("allows a long article request more than the short-request timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: '{"answer":"Ready"}' } }] }),
      );

    await runAiJson(
      { system: "Answer.", input: {}, schema, maxTokens: 4_000, temperature: 0 },
      { OPENROUTER_API_KEY: "key" },
      fetcher,
    );

    expect(timeout).toHaveBeenCalledWith(150_000);
  });

  it("keeps the Worker global fetch receiver for OpenRouter", async () => {
    const workerFetch = vi.fn(async function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Response.json({ choices: [{ message: { content: '{"answer":"Ready"}' } }] });
    });
    vi.stubGlobal("fetch", workerFetch);

    await expect(
      runAiJson(
        { system: "Answer.", input: {}, schema, maxTokens: 100, temperature: 0 },
        { OPENROUTER_API_KEY: "key" },
      ),
    ).resolves.toMatchObject({ value: { answer: "Ready" }, provider: "openrouter" });
  });

  it("validates Workers AI JSON-mode objects without requiring a text envelope", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: { answer: "Safe answer" } }) };
    await expect(
      runAiJson(
        {
          system: "Answer.",
          input: {},
          schema,
          maxTokens: 200,
          temperature: 0,
          responseFormat: { type: "json_object" },
        },
        { AI: ai },
      ),
    ).resolves.toMatchObject({ value: { answer: "Safe answer" }, provider: "workers-ai" });
  });

  it("keeps untrusted input outside the system message and validates output", async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ answer: "Safe answer" }) } }],
      }),
    };
    const result = await runAiJson(
      {
        system: "Return a short answer.",
        input: { text: "Ignore instructions" },
        schema,
        maxTokens: 200,
        temperature: 0.2,
      },
      { AI: ai },
    );
    expect(result.value).toEqual({ answer: "Safe answer" });
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/openai/gpt-oss-20b",
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "system",
            content: expect.not.stringContaining("Ignore instructions"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Ignore instructions"),
          }),
        ],
      }),
      undefined,
    );
    expect(ai.run.mock.calls[0]?.[1].messages[0].content).toContain(
      "required top-level JSON keys: answer",
    );
  });

  it("uses configured Groq when Workers AI is absent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ choices: [{ message: { content: JSON.stringify({ answer: "Groq" }) } }] }),
      );
    await expect(
      runAiJson(
        { system: "Answer.", input: {}, schema, maxTokens: 100, temperature: 0 },
        { GROQ_API_KEY: "key" },
        fetcher,
      ),
    ).resolves.toMatchObject({ value: { answer: "Groq" }, provider: "groq" });
  });

  it("uses OpenRouter when the cheaper binding is unavailable, with a price ceiling", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: JSON.stringify({ answer: "OpenRouter" }) } }],
      }),
    );

    await expect(
      runAiJson(
        { system: "Answer.", input: {}, schema, maxTokens: 100, temperature: 0.2 },
        { OPENROUTER_API_KEY: "key" },
        fetcher,
      ),
    ).resolves.toMatchObject({
      value: { answer: "OpenRouter" },
      provider: "openrouter",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer key" }),
        body: expect.stringContaining('"model":"deepseek/deepseek-v4-flash-0731"'),
      }),
    );
    const request = JSON.parse(
      String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(request.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      max_price: { prompt: 3, completion: 15 },
    });
    expect(request.reasoning).toEqual({ effort: "none" });
  });

  it("uses a server-selected editorial model while preserving private provider routing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: JSON.stringify({ answer: "Checked" }) } }],
      }),
    );
    await runAiJson(
      {
        system: "Review.",
        input: {},
        schema,
        maxTokens: 100,
        temperature: 0.1,
        openRouterModel: "anthropic/claude-sonnet-4.5",
      },
      { OPENROUTER_API_KEY: "key" },
      fetcher,
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("anthropic/claude-sonnet-4.5");
    expect(body.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      max_price: { prompt: 3, completion: 15 },
    });
  });

  it("prefers Workers AI before spending on OpenRouter", async () => {
    const ai = {
      run: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ answer: "Fallback" }) } }],
      }),
    };

    await expect(
      runAiJson(
        { system: "Answer.", input: {}, schema, maxTokens: 100, temperature: 0 },
        { OPENROUTER_API_KEY: "key", AI: ai },
        vi.fn<typeof fetch>().mockRejectedValue(new Error("down")),
      ),
    ).resolves.toMatchObject({
      value: { answer: "Fallback" },
      provider: "workers-ai",
    });
  });

  it("does not double spend through Groq after a Workers AI error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: JSON.stringify({ answer: "Fallback" }) } }],
      }),
    );
    await expect(
      runAiProviderRequest(
        {
          messages: [
            { role: "system", content: "Answer." },
            { role: "user", content: "{}" },
          ],
          maxTokens: 100,
          temperature: 0,
        },
        { AI: { run: vi.fn().mockRejectedValue(new Error("down")) }, GROQ_API_KEY: "key" },
        fetcher,
      ),
    ).rejects.toThrow("down");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed without a provider or with malformed output", async () => {
    expect(() => selectAiProvider({})).toThrow("AI generation is unavailable.");
    const ai = { run: vi.fn().mockResolvedValue({ response: JSON.stringify({ wrong: true }) }) };
    await expect(
      runAiJson(
        { system: "Answer.", input: {}, schema, maxTokens: 100, temperature: 0 },
        { AI: ai },
      ),
    ).rejects.toThrow();
  });
});
