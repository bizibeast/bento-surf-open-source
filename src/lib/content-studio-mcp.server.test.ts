import { afterEach, expect, it, vi } from "vitest";
import { registerContentStudioMcpTools } from "./content-studio-mcp.server";

const status = vi.hoisted(() => vi.fn());
vi.mock("./studio-carousel-jobs.server", () => ({ studioCarouselJobStatus: status }));

const userId = "00000000-0000-4000-8000-000000000010";
const workspaceId = "00000000-0000-4000-8000-000000000011";
const entryId = "00000000-0000-4000-8000-000000000012";
const auth = { clientId: "fixture", token: "fixture", scopes: ["openid"], extra: { userId } };

afterEach(() => {
  vi.unstubAllEnvs();
  status.mockReset();
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
