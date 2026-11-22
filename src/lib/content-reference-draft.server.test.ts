import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { studioStarter } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  actor: vi.fn(),
  evidence: vi.fn(),
  ai: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  model: vi.fn(),
  editorial: vi.fn(),
  plan: "creator",
  catalog: "legacy",
  provider: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "profiles")
        return query({ plan_id: mocks.plan, billing_catalog: mocks.catalog });
      if (table === "complimentary_plan_grants") return query(null);
      if (table === "benny_ai_providers") return mocks.provider();
      return mocks.from(table);
    },
    rpc: mocks.rpc,
  },
}));
vi.mock("./content-reference-jobs.server", async (original) => ({
  ...(await original<typeof import("./content-reference-jobs.server")>()),
  requireReferenceActor: mocks.actor,
  loadReferenceEvidence: mocks.evidence,
}));
vi.mock("./ai-json.server", () => ({ runAiJson: mocks.ai }));
vi.mock("./content-studio.server", () => ({
  saveContentStudioEntryForWorkspace: mocks.save,
  listContentStudioEntriesForWorkspace: mocks.list,
}));
vi.mock("./benny-models.server", () => ({ withBennyEditingModel: mocks.model }));
vi.mock("./content-agent.server", () => ({
  loadContentEditorialContext: mocks.editorial,
}));
import { createReferenceDraft } from "./content-reference-draft.server";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
const receiptId = "33333333-3333-4333-8333-333333333333";
const actor = { workspaceId, authUserId };
const seed = studioStarter("carousel", "split", DEFAULT_AGENT_BRANDING);
const input = {
  workspaceId,
  requestId: authUserId,
  analysisId: receiptId,
  prompt: "My original idea",
  kind: "project" as const,
  document: seed.document,
};
const generatedDraft = {
  format: "carousel",
  title: "An original guide",
  slides: [
    { heading: "My own opening", body: "A new lesson" },
    { heading: "Try this", body: "My next step" },
  ],
};
function query(data: unknown) {
  const response = { data, error: null };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "update"]) chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => response);
  chain.then = vi.fn((resolve) => Promise.resolve(response).then(resolve));
  return chain;
}
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.plan = "creator";
  mocks.catalog = "legacy";
  vi.stubEnv("BENTO_EDITION", "hosted");
  vi.stubEnv("BENNY_BYOK_ENABLED", "true");
  vi.stubEnv("BENNY_BYOK_WORKSPACES", "*");
  vi.stubEnv("BENNY_BYOK_ENCRYPTION_KEY", "ab".repeat(32));
  mocks.editorial.mockResolvedValue({ brain: [] });
  mocks.evidence.mockResolvedValue({
    format: "carousel",
    sourceUrl: "https://www.instagram.com/p/abc/",
    visuals: [{ index: 0, description: "Bold hook followed by practical steps" }],
    warnings: ["Slide two could not be read."],
  });
  mocks.list.mockResolvedValue([]);
  const { withBennyEditingModel } =
    await vi.importActual<typeof import("./benny-models.server")>("./benny-models.server");
  mocks.model.mockImplementation(withBennyEditingModel);
  mocks.ai.mockResolvedValue({ value: generatedDraft });
  mocks.save.mockImplementation(async (_workspaceId, entry) => ({ ...entry, revision: 1 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("creates real editable copy from grounded evidence while preserving theme and surfacing missing evidence", async () => {
  mocks.plan = "creator_plus";
  mocks.catalog = "2026-11-managed";
  const existing = query(null),
    checkpoint = query({ id: receiptId }),
    ready = query(null);
  mocks.from
    .mockReturnValueOnce(existing)
    .mockReturnValueOnce(checkpoint)
    .mockReturnValueOnce(ready);
  mocks.rpc.mockResolvedValue({ data: receiptId, error: null });
  const result = await createReferenceDraft(actor, { ...input, aiModel: "openai/gpt-6.2-sol" });
  expect(mocks.model).toHaveBeenCalledWith("openai/gpt-6.2-sol", expect.any(Function));
  expect(mocks.ai.mock.calls[0][0].input.referenceEvidence.visuals[0].description).toContain(
    "Bold hook",
  );
  expect(result.entry.document.format === "carousel" && result.entry.document.layout).toBe("split");
  expect(result.entry.document.brand).toEqual(seed.document.brand);
  expect(result.entry.id).toBe(receiptId);
  expect(result.entry.revision).toBe(1);
  expect(result.warnings).toEqual(["Slide two could not be read."]);
  expect(checkpoint.update).toHaveBeenCalledWith(expect.objectContaining({ status: "generated" }));
  expect(mocks.save).toHaveBeenCalledOnce();
});
it("retries only a local save after a persisted completion, without buying another AI request", async () => {
  const output = {
    entry: { ...seed, id: receiptId },
    warnings: ["An audio track was unavailable."],
  };
  mocks.evidence.mockRejectedValue(new Error("This reference has expired."));
  mocks.from
    .mockReturnValueOnce(query({ id: receiptId, input, output, status: "generated" }))
    .mockReturnValueOnce(query(null));
  const result = await createReferenceDraft(actor, input);
  expect(result.entry.id).toBe(receiptId);
  expect(result.warnings).toEqual(output.warnings);
  expect(mocks.evidence).not.toHaveBeenCalled();
  expect(mocks.ai).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith(workspaceId, output.entry);
});
it("returns a saved draft idempotently and never overwrites subsequent human edits", async () => {
  const edited = { ...seed, id: receiptId, revision: 3, title: "My human edits" };
  const output = { entry: { ...seed, id: receiptId }, warnings: ["Slide two was unavailable."] };
  mocks.evidence.mockRejectedValue(new Error("This reference has expired."));
  mocks.from.mockReturnValueOnce(query({ id: receiptId, input, output, status: "ready" }));
  mocks.list.mockResolvedValue([edited]);
  expect(await createReferenceDraft(actor, input)).toMatchObject({
    entry: edited,
    warnings: output.warnings,
  });
  expect(mocks.evidence).not.toHaveBeenCalled();
  expect(mocks.ai).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it.each(["[]", "[   ]", "[1]", "Finished copy"])(
  "rejects a preset with %s in its slides without checkpointing or calling AI again",
  async (heading) => {
    const failing = query(null);
    mocks.from.mockReturnValueOnce(query(null)).mockReturnValueOnce(failing);
    mocks.rpc.mockResolvedValue({ data: receiptId, error: null });
    mocks.ai.mockResolvedValueOnce({
      value: {
        format: "carousel",
        title: "[Title]",
        slides: [
          { heading, body: "A new lesson" },
          { heading: "Try this", body: "" },
        ],
      },
    });
    await expect(createReferenceDraft(actor, { ...input, kind: "preset" })).rejects.toThrow(
      "no editable placeholders",
    );
    expect(mocks.ai).toHaveBeenCalledOnce();
    expect(failing.update).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
    expect(mocks.save).not.toHaveBeenCalled();
  },
);
it("saves a reusable preset when editable slide content contains a descriptive placeholder", async () => {
  mocks.from
    .mockReturnValueOnce(query(null))
    .mockReturnValueOnce(query({ id: receiptId }))
    .mockReturnValueOnce(query(null));
  mocks.rpc.mockResolvedValue({ data: receiptId, error: null });
  mocks.ai.mockResolvedValueOnce({
    value: {
      format: "carousel",
      title: "A reusable guide",
      slides: [
        { heading: "[Your topic]", body: "" },
        { heading: "Try this", body: "[Add your example]" },
      ],
    },
  });
  expect((await createReferenceDraft(actor, { ...input, kind: "preset" })).entry).toMatchObject({
    kind: "preset",
    document: { slides: [{ heading: "[Your topic]" }, { body: "[Add your example]" }] },
  });
});
it.each(["generating", "failed"])(
  "never repeats an ambiguous or failed %s generation",
  async (status) => {
    mocks.from.mockReturnValueOnce(query({ id: receiptId, input, status }));
    await expect(createReferenceDraft(actor, input)).rejects.toThrow("will not be retried");
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);
it("does not generate from an unexamined URL or another workspace", async () => {
  await expect(createReferenceDraft(actor, { ...input, workspaceId: authUserId })).rejects.toThrow(
    "another workspace",
  );
  expect(mocks.actor).not.toHaveBeenCalled();
  mocks.from.mockReturnValueOnce(query(null));
  mocks.evidence.mockResolvedValue({
    format: "reel",
    visuals: [],
    warnings: ["No vision evidence."],
  });
  await expect(createReferenceDraft(actor, input)).rejects.toThrow(
    "Visual analysis is unavailable",
  );
  expect(mocks.ai).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("denies hosted drafting on current Creator before any provider, reservation or generation claim", async () => {
  mocks.catalog = "2026-10";
  mocks.from.mockReturnValue(query(null));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(createReferenceDraft(actor, input)).rejects.toThrow("Brain");
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.ai).not.toHaveBeenCalled();
  expect(mocks.evidence).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([200, 429])(
  "uses only the current Creator's owned transport when it returns %s",
  async (status) => {
    mocks.catalog = "2026-10";
    const { encryptServerSecret } = await import("./secret-crypto.server");
    const provider = query({
      model: "example/default",
      additional_models: ["example/selected"],
      encrypted_api_key: await encryptServerSecret("fixture-personal-key", "benny-byok"),
      provider_kind: "openrouter",
    });
    mocks.provider.mockReturnValue(provider);
    const args = { ...input, aiProviderId: authUserId, aiModel: "example/selected" };
    const real = await vi.importActual<typeof import("./ai-json.server")>("./ai-json.server");
    mocks.ai.mockImplementationOnce(real.runAiJson);
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { choices: [{ message: { content: JSON.stringify(generatedDraft) } }] },
          { status },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    mocks.from
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ id: receiptId }))
      .mockReturnValueOnce(query(null));
    mocks.rpc.mockResolvedValue({ data: receiptId, error: null });
    if (status === 200) {
      await expect(createReferenceDraft(actor, args)).resolves.toMatchObject({
        entry: { id: receiptId, revision: 1 },
      });
    } else {
      await expect(createReferenceDraft(actor, args)).rejects.toThrow("declined");
      expect(mocks.save).not.toHaveBeenCalled();
    }
    expect(provider.eq.mock.calls).toEqual([
      ["workspace_id", workspaceId],
      ["owner_id", authUserId],
      ["id", authUserId],
    ]);
    expect(mocks.editorial).toHaveBeenCalledWith(workspaceId, input.prompt, undefined, "discover");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ model: "example/selected" });
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "claim_content_reference_draft",
      expect.objectContaining({ p_input: args }),
    );
  },
);
it("rejects unmanaged model IDs and credential fields before any claim", async () => {
  await expect(
    createReferenceDraft(actor, { ...input, aiModel: "example/unsaved" }),
  ).rejects.toThrow("editing model");
  const withSecret = { ...input, aiProviderId: receiptId, apiKey: "untrusted-client-input" };
  await expect(createReferenceDraft(actor, withSecret)).rejects.toThrow("Unrecognized");
  expect(mocks.from).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it.each(["foreign", "disabled"])(
  "rejects a %s provider without generating or claiming a draft",
  async (condition) => {
    mocks.catalog = "2026-10";
    if (condition === "disabled") vi.stubEnv("BENNY_BYOK_ENABLED", "false");
    const provider = query(null);
    mocks.provider.mockReturnValue(provider);
    mocks.from.mockReturnValue(query(null));
    await expect(
      createReferenceDraft(actor, { ...input, aiProviderId: receiptId }),
    ).rejects.toThrow(/provider|model/i);
    if (condition === "foreign")
      expect(provider.eq.mock.calls).toEqual([
        ["workspace_id", workspaceId],
        ["owner_id", authUserId],
        ["id", receiptId],
      ]);
    else expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
  },
);
