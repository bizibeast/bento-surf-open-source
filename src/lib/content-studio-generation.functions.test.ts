import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FULLY_MANAGED_BILLING_CATALOG } from "./plans";
import { selectedBennyEditingModel } from "./benny-models.server";
import { studioStarter } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  ai: vi.fn(),
  editorial: vi.fn(),
  byok: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const fn = {
      middleware: () => fn,
      validator: (v: typeof validate) => {
        validate = v;
        return fn;
      },
      handler: (handler: (input: unknown) => unknown) => (input?: { data: unknown }) =>
        handler({
          context: { workspaceId: "11111111-1111-4111-8111-111111111111", authUserId: "owner" },
          data: validate(input?.data),
        }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./plan.server", () => ({ getBillingCatalog: mocks.catalog }));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: vi.fn() }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./content-agent.server", () => ({ loadContentEditorialContext: mocks.editorial }));
vi.mock("./benny-byok.server", () => ({
  bennyInferenceForProvider: mocks.byok,
  canUseBennyByok: async () => true,
}));
vi.mock("./ai-json.server", () => ({ runAiJson: mocks.ai }));
import { generateContentStudioDraft } from "./content-studio-generation.functions";
const document = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING).document;
const data = {
  workspaceId,
  title: "Draft",
  prompt: "Edit my carousel",
  document,
  aiModel: "anthropic/claude-fable-5.2",
};
const result = {
  format: "carousel",
  title: "Edited",
  slides: [
    { heading: "One", body: "First" },
    { heading: "Two", body: "Second" },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BENTO_V2_STUDIO_ENABLED", "true");
  mocks.catalog.mockResolvedValue(FULLY_MANAGED_BILLING_CATALOG);
  mocks.editorial.mockResolvedValue({ sources: [], brain: [] });
  mocks.ai.mockResolvedValue({ value: result });
});
afterEach(() => vi.unstubAllEnvs());
it("uses the requested managed model for editable drafts without a BYOK transport", async () => {
  mocks.ai.mockImplementationOnce(async (...args) => {
    expect(selectedBennyEditingModel()).toBe(data.aiModel);
    expect(args[3]).toBeUndefined();
    return { value: result };
  });
  expect((await generateContentStudioDraft({ data })).title).toBe("Edited");
  expect(selectedBennyEditingModel()).toBeUndefined();
  expect(mocks.byok).not.toHaveBeenCalled();
});
it("rejects Creator funding of a premium model before loading context or invoking AI", async () => {
  mocks.catalog.mockResolvedValue("2026-10");
  await expect(generateContentStudioDraft({ data })).rejects.toThrow(/Creator\+/);
  expect(mocks.editorial).not.toHaveBeenCalled();
  expect(mocks.ai).not.toHaveBeenCalled();
});

it("gives visual revisions the existing scene identities, durations and approved speech", async () => {
  const document = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
  if (document.format !== "reel") throw Error("fixture");
  document.scenes = [
    {
      ...document.scenes[0],
      duration: 7,
      avatarScript: "Keep these exact words",
      narrationJobId: crypto.randomUUID(),
      mediaId: crypto.randomUUID(),
    },
  ];
  mocks.ai.mockImplementationOnce(async (request) => {
    expect(request.input.previousCopy).toEqual([
      expect.objectContaining({
        sourceSceneId: document.scenes[0].id,
        duration: 7,
        speakerScript: "Keep these exact words",
        avatarVisible: false,
      }),
    ]);
    expect(JSON.stringify(request.input.previousCopy)).not.toContain(
      document.scenes[0].narrationJobId!,
    );
    return {
      value: { format: "reel", title: "Visual revision", scenes: request.input.previousCopy },
    };
  });
  const result = await generateContentStudioDraft({
    data: { ...data, document, prompt: "Keep my script, only change the layout" },
  });
  expect(result.document).toEqual(document);
});
it("rejects arbitrary paid model IDs even with a managed catalog", async () => {
  await expect(
    generateContentStudioDraft({ data: { ...data, aiModel: "random/expensive" } }),
  ).rejects.toThrow(/unavailable/);
  expect(mocks.ai).not.toHaveBeenCalled();
});
it("rejects cross-tenant studio inputs", async () => {
  await expect(
    generateContentStudioDraft({
      data: { ...data, workspaceId: "22222222-2222-4222-8222-222222222222" },
    }),
  ).rejects.toThrow(/workspace/);
  expect(mocks.ai).not.toHaveBeenCalled();
});
