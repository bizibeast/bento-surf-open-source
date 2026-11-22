import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planHasEntitlement } from "./plans";
import type { AiProviderRequest } from "./ai-json.server";
import { decryptServerSecret } from "./secret-crypto.server";
import {
  bennyInferenceForProvider,
  bennyProviderTarget,
  createBennyProviderTransport,
  canUseBennyByok,
  checkBennyOpenRouterKey,
  createBennyOpenRouterTransport,
  discoverBennyModels,
  saveBennyProvider,
} from "./benny-byok.server";

const { entitlements, reserve, from } = vi.hoisted(() => ({
  entitlements: vi.fn(),
  reserve: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));
vi.mock("./plan.server", () => ({ hasPlanEntitlement: entitlements }));
vi.mock("./provider-budget.server", () => ({ reserveAiProviderUsage: reserve }));

const workspace = "10000000-0000-4000-8000-000000000001";
const key = "sk-or-fake-byok-connection";
const request: AiProviderRequest = {
  messages: [{ role: "user", content: "Creator context" }],
  maxTokens: 100,
  temperature: 0.3,
};

describe("Benny BYOK", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "platform-key");
    vi.stubEnv("BENNY_BYOK_ENABLED", "true");
    vi.stubEnv("BENNY_BYOK_WORKSPACES", workspace);
    vi.stubEnv("BENNY_BYOK_ENCRYPTION_KEY", "01".repeat(32));
    entitlements.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("only connects custom providers to approved TLS origins and API paths", () => {
    vi.stubEnv(
      "BENNY_BYOK_CUSTOM_BASE_URLS",
      "https://llm.example.com/v1/, https://127.0.0.1/v1/, https://worker.internal/v1/",
    );
    expect(bennyProviderTarget("compatible", "https://llm.example.com/v1").url).toBe(
      "https://llm.example.com/v1/",
    );
    for (const target of [
      "https://llm.example.com/admin",
      "https://llm.example.com.evil/v1/",
      "https://llm.example.com/v1/?key=secret",
      "https://127.0.0.1/v1/",
      "https://worker.internal/v1/",
      "https://user@llm.example.com/v1/",
      "http://llm.example.com/v1/",
    ])
      expect(() => bennyProviderTarget("compatible", target)).toThrow("approved");
  });

  it("uses OpenAI chat token limits and makes no Bento-funded reservation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: '{"message":"Hello"}' } }],
      }),
    );
    const transport = createBennyProviderTransport(
      bennyProviderTarget("openai"),
      key,
      "gpt-test",
      fetcher,
    );
    await expect(transport(request)).resolves.toMatchObject({ provider: "openai" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-test",
      messages: request.messages,
      max_completion_tokens: request.maxTokens,
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects an unsaved model selection on an owned connection", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { model: "author/primary", additional_models: ["author/secondary"] },
        error: null,
      }),
    };
    from.mockReturnValueOnce(query);
    await expect(
      bennyInferenceForProvider(
        { workspaceId: workspace, authUserId: "member" },
        "owned-id",
        "author/other",
      ),
    ).rejects.toThrow("Choose a saved model");
  });

  it("checks the feature flag, exact workspace and separate entitlement", async () => {
    await expect(canUseBennyByok(workspace)).resolves.toBe(true);
    expect(entitlements).toHaveBeenCalledWith(workspace, "bennyByok");
    await expect(canUseBennyByok(`${workspace}-different`)).resolves.toBe(false);
    vi.stubEnv("BENNY_BYOK_ENCRYPTION_KEY", "");
    await expect(canUseBennyByok(workspace)).resolves.toBe(false);
    vi.stubEnv("BENNY_BYOK_ENABLED", "false");
    await expect(canUseBennyByok(workspace)).resolves.toBe(false);
    expect(entitlements).toHaveBeenCalledTimes(1);
    expect(planHasEntitlement("creator", "bennyByok")).toBe(true);
    expect(planHasEntitlement("creator_plus", "bennyByok")).toBe(true);
    expect(planHasEntitlement("creator", "brain")).toBe(false);
    expect(planHasEntitlement("creator", "brain", "legacy")).toBe(true);
    expect(planHasEntitlement("store", "bennyByok")).toBe(false);
    expect(planHasEntitlement("free", "bennyByok")).toBe(false);
  });

  it("requires the plan entitlement when the full workspace cohort is enabled", async () => {
    vi.stubEnv("BENNY_BYOK_WORKSPACES", " * ");
    entitlements.mockResolvedValueOnce(false);
    await expect(canUseBennyByok(workspace)).resolves.toBe(false);
    await expect(canUseBennyByok(workspace)).resolves.toBe(true);
    expect(entitlements).toHaveBeenCalledWith(workspace, "bennyByok");
  });

  it("looks up a connection by workspace, signed-in member and provider ID", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    from.mockReturnValueOnce(query);
    const providerId = "30000000-0000-4000-8000-000000000001";
    await expect(
      bennyInferenceForProvider({ workspaceId: workspace, authUserId: "member" }, providerId),
    ).rejects.toThrow("This Benny provider is unavailable.");
    expect(query.eq.mock.calls).toEqual([
      ["workspace_id", workspace],
      ["owner_id", "member"],
      ["id", providerId],
    ]);
  });

  it("writes ciphertext scoped to the member and only returns display metadata", async () => {
    const metadata = { id: "provider-id", name: "My connection", model: "author/model" };
    const query = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: metadata, error: null }),
    };
    from.mockReturnValueOnce(query);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}));
    const result = await saveBennyProvider(
      { workspaceId: workspace, authUserId: "member" },
      { name: metadata.name, model: metadata.model, apiKey: key },
    );
    expect(result).toEqual(metadata);
    const values = query.insert.mock.calls[0]![0];
    expect(values).toMatchObject({ workspace_id: workspace, owner_id: "member" });
    expect(JSON.stringify(values)).not.toContain(key);
    await expect(decryptServerSecret(values.encrypted_api_key, "benny-byok")).resolves.toBe(key);
    expect(query.select).toHaveBeenCalledWith(
      "id,name,model,provider_kind,base_url,additional_models",
    );
  });

  it("tests the account with the authenticated key endpoint and discovers only text models", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { label: "private" } }))
      .mockResolvedValueOnce(
        Response.json({
          data: [
            {
              id: "author/chat",
              name: "Chat",
              supported_parameters: ["response_format"],
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            },
            {
              id: "author/image",
              name: "Image",
              architecture: { input_modalities: ["text"], output_modalities: ["image"] },
            },
            { id: "unexpected/row", name: "Unknown" },
          ],
        }),
      );
    await expect(discoverBennyModels(key, fetcher)).resolves.toEqual([
      { id: "author/chat", name: "Chat", jsonMode: true },
    ]);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/models",
    ]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}` },
    });
  });

  it("uses only the selected model and credential and drops provider response metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content: '{"message":"Hello"}' } }],
        provider: "upstream",
        diagnostics: key,
      }),
    );
    const transport = createBennyOpenRouterTransport(key, "author/model", fetcher);
    const output = await transport(request);
    expect(output).toEqual({
      provider: "openrouter",
      response: { choices: [{ message: { content: '{"message":"Hello"}' } }] },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "author/model",
      messages: request.messages,
      max_tokens: 100,
      provider: { allow_fallbacks: false, require_parameters: true },
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("fails closed on provider rejection and never calls a Bento-funded fallback", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ error: { message: key } }, { status: 401 }));
    await expect(checkBennyOpenRouterKey(key, fetcher)).rejects.toThrow("OpenRouter rejected");
    const transport = createBennyOpenRouterTransport(key, "author/model", fetcher);
    await expect(transport(request)).rejects.toThrow(/^OpenRouter rejected the connection\./);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects redirection errors, oversized requests, credential echoes and repeated calls", async () => {
    const blocked = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Redirect with ${key}`));
    await expect(
      createBennyOpenRouterTransport(key, "author/model", blocked)(request),
    ).rejects.toThrow("OpenRouter could not finish");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content: key } }],
      }),
    );
    const transport = createBennyOpenRouterTransport(key, "author/model", fetcher);
    await expect(
      transport({ ...request, messages: [{ role: "user", content: "a".repeat(130_000) }] }),
    ).rejects.toThrow("too large");
    await expect(
      transport({ ...request, messages: [{ role: "user", content: key }] }),
    ).rejects.toThrow("Remove your API key");
    expect(fetcher).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(transport(request)).rejects.toThrow("no structured output");
    }
    await expect(transport(request)).rejects.toThrow("request limit");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
