import { afterEach, expect, it, vi } from "vitest";
import { registerContentStudioMcpTools } from "./content-studio-mcp.server";

const status = vi.hoisted(() => vi.fn());
const savedEntries = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), brand: vi.fn() }));
vi.mock("./studio-carousel-jobs.server", () => ({ studioCarouselJobStatus: status }));
vi.mock("./content-studio.server", () => ({
  listContentStudioEntriesForWorkspace: savedEntries.list,
  saveContentStudioEntryForWorkspace: savedEntries.save,
  getStudioWorkspaceBrand: savedEntries.brand,
}));
vi.mock("./content-creation-history.server", () => ({
  loadContentCreationHistory: vi.fn().mockResolvedValue(null),
}));
import { studioStarter } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { studioDraftContext } from "./content-studio-generation";

const userId = "00000000-0000-4000-8000-000000000010";
const workspaceId = "00000000-0000-4000-8000-000000000011";
const entryId = "00000000-0000-4000-8000-000000000012";
const auth = { clientId: "fixture", token: "fixture", scopes: ["openid"], extra: { userId } };

afterEach(() => {
  vi.unstubAllEnvs();
  status.mockReset();
  Object.values(savedEntries).forEach((mock) => mock.mockReset());
});

it("revises the currently owned saved copy in chat while retaining photos and enforcing revision checks", async () => {
  vi.stubEnv("BENTO_V2_STUDIO_ENABLED", "true");
  const document = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING).document;
  if (document.format !== "carousel") throw Error("fixture");
  document.slides[0].mediaId = crypto.randomUUID();
  const entry = { id: entryId, kind: "project", title: "Original", revision: 4, document };
  savedEntries.list.mockResolvedValue([entry]);
  savedEntries.save.mockImplementation(async (_workspace, input) => ({ ...input, revision: 5 }));
  const registerTool = vi.fn();
  const resolveWorkspace = vi.fn().mockResolvedValue(workspaceId);
  registerContentStudioMcpTools({ registerTool }, auth, resolveWorkspace);
  const [, config, revise] = registerTool.mock.calls.find(
    ([name]) => name === "revise_content_studio_copy",
  )!;
  expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  const draft = { format: "carousel", title: "Revised", slides: studioDraftContext(document) };
  const input = { workspaceId, entryId, revision: 4, draft };
  expect(config.inputSchema.safeParse(input).success).toBe(true);
  const result = await revise(input);
  expect(resolveWorkspace).toHaveBeenCalledWith(userId, workspaceId);
  expect(savedEntries.list).toHaveBeenCalledWith(workspaceId);
  expect(savedEntries.save).toHaveBeenCalledWith(workspaceId, { ...entry, title: "Revised" });
  expect(result.structuredContent.entry).toMatchObject({ revision: 5, document });
  expect(result.structuredContent.editingReview.format).toBe("carousel");
  await expect(revise({ ...input, revision: 3 })).rejects.toThrow(/changed in another session/);
  await expect(revise({ ...input, entryId: crypto.randomUUID() })).rejects.toThrow(/unavailable/);
  await expect(
    revise({ ...input, draft: { ...draft, slides: [draft.slides[0], draft.slides[0]] } }),
  ).rejects.toThrow(/at most once/);
  expect(savedEntries.save).toHaveBeenCalledOnce();
  resolveWorkspace.mockRejectedValueOnce(new Error("Unavailable workspace"));
  await expect(revise(input)).rejects.toThrow("Unavailable workspace");
  expect(savedEntries.save).toHaveBeenCalledOnce();
});

it("exposes source identities and timing with the existing owned saved-content read", async () => {
  vi.stubEnv("BENTO_V2_STUDIO_ENABLED", "true");
  const document = studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
  savedEntries.list.mockResolvedValue([{ id: entryId, revision: 2, document }]);
  savedEntries.brand.mockResolvedValue(DEFAULT_AGENT_BRANDING);
  const registerTool = vi.fn();
  registerContentStudioMcpTools({ registerTool }, auth, vi.fn().mockResolvedValue(workspaceId));
  const call = registerTool.mock.calls.find(([name]) => name === "get_content_studio_projects")!;
  expect(call[1].annotations.readOnlyHint).toBe(true);
  const result = await call[2]({ workspaceId, entryId });
  expect(result.structuredContent.entry.id).toBe(entryId);
  if (document.format !== "reel") throw Error("fixture");
  expect(result.structuredContent.copyRevision[0]).toMatchObject({
    sourceSceneId: document.scenes[0].id,
    duration: document.scenes[0].duration,
    speakerScript: document.scenes[0].avatarScript,
  });
});

it("checks the selected workspace and requester before returning a background export", async () => {
  vi.stubEnv("BENTO_V2_STUDIO_ENABLED", "true");
  const state = { status: "ready", media_ids: [entryId] };
  status.mockResolvedValue({ available: true, job: state, photosAvailable: true });
  const registerTool = vi.fn();
  const resolveWorkspace = vi.fn().mockResolvedValue(workspaceId);
  registerContentStudioMcpTools({ registerTool }, auth, resolveWorkspace);
  const call = registerTool.mock.calls.find(([name]) => name === "get_content_studio_render");
  if (!call) throw new Error("Expected Studio render status tool.");
  expect(call[1].annotations).toMatchObject({ readOnlyHint: true });
  const input = { workspaceId, entryId, revision: 2, format: "reel" };
  await expect(call[2](input)).resolves.toMatchObject({ structuredContent: { job: state } });
  expect(resolveWorkspace).toHaveBeenCalledWith(userId, workspaceId);
  expect(status).toHaveBeenCalledWith(input, userId);
  resolveWorkspace.mockRejectedValueOnce(new Error("Unavailable workspace"));
  await expect(call[2](input)).rejects.toThrow("Unavailable workspace");
  expect(status).toHaveBeenCalledOnce();
});
