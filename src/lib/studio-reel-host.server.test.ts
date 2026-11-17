import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { studioStarter, newReelScene } from "./content-studio";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { renderStudioReelOnHost } from "./studio-reel-host.server";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  settle: vi.fn(),
  connectedAvatar: vi.fn(),
  workspace: vi.fn(),
  get: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("./provider-budget.server", () => ({
  reserveManagedProviderUsage: mocks.reserve,
  settleProviderUsage: mocks.settle,
}));
vi.mock("./external-tools.server", () => ({ readHeyGenJob: mocks.connectedAvatar }));
vi.mock("./workspace-session.server", () => ({ resolveWorkspace: mocks.workspace }));

const workspaceId = "974a76fd-a418-4cc5-9f77-765d36ee6d3b";
const authUserId = "928c714b-7601-411c-a830-805223e7006d";
const jobId = "de1a68b3-83be-4a04-a878-f0f1c1327d6e";
const key = `private/users/${workspaceId}/heygen/${jobId}.mp4`;
const bucket = { get: mocks.get } as unknown as R2Bucket;

function project() {
  const { document } = studioStarter("reel", "jump-cut", DEFAULT_AGENT_BRANDING);
  if (document.format !== "reel") throw new Error("Expected Reel fixture.");
  document.scenes = [newReelScene({ kind: "avatar", avatarJobId: jobId, title: "Private clip" })];
  return document;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BENTO_V2_STUDIO_SERVER_REELS", "true");
  vi.stubEnv("STUDIO_REEL_RENDERER_URL", "https://render.example.com/render");
  vi.stubEnv("STUDIO_REEL_RENDERER_TOKEN", "test_renderer_token_000000000000000000");
  vi.stubEnv("STUDIO_REEL_ATTEMPT_MICROUSD", "5000");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.workspace.mockResolvedValue({ workspaceId, workspace: { status: "active" } });
  mocks.reserve.mockResolvedValue({ id: jobId, units: 5000, managed: true });
  mocks.connectedAvatar.mockResolvedValue({ status: "ready", assetKey: key });
  mocks.get.mockResolvedValue({
    size: 24,
    httpMetadata: { contentType: "video/mp4" },
    arrayBuffer: async () => new ArrayBuffer(24),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("reserves spend and sends only owned media bytes to the configured host", async () => {
  const output = new TextEncoder().encode("0000ftypfixture");
  mocks.fetch.mockResolvedValueOnce(
    new Response(output, { headers: { "content-type": "video/mp4" } }),
  );
  const rendered = await renderStudioReelOnHost({
    bucket,
    workspaceId,
    authUserId,
    document: project(),
    maxBytes: 64,
  });
  expect(Array.from(rendered)).toEqual(Array.from(output));
  expect(mocks.connectedAvatar).toHaveBeenCalledWith(
    { workspaceId, authUserId, clientId: "bento-browser" },
    jobId,
  );
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(mocks.get).toHaveBeenCalledWith(key);
  expect(mocks.reserve).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId,
      authUserId,
      resource: "studio_reel_browser_milliseconds",
      providerUnits: 100_000,
      units: 5_000,
    }),
  );
  expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.fetch.mock.invocationCallOrder[0],
  );
  expect(mocks.settle).toHaveBeenCalledWith({ id: jobId, units: 5000, managed: true }, 5000);
  const [url, options] = mocks.fetch.mock.calls[0];
  expect(String(url)).toBe("https://render.example.com/render");
  expect(options).toMatchObject({ method: "POST", redirect: "error" });
  const form = options.body as FormData;
  expect(form.get(jobId)).toMatchObject({ type: "video/mp4", size: 24 });
  expect(JSON.parse(String(form.get("document"))).document.scenes[0].mediaId).toBe(jobId);
});

it("makes no paid request after a workspace, media or spending check fails", async () => {
  const input = { bucket, workspaceId, authUserId, document: project(), maxBytes: 64 };
  mocks.workspace.mockResolvedValueOnce({
    workspaceId: "another",
    workspace: { status: "active" },
  });
  await expect(renderStudioReelOnHost(input)).rejects.toThrow("no longer available");
  mocks.connectedAvatar.mockResolvedValueOnce({
    status: "ready",
    assetKey: key.replace(workspaceId, "another"),
  });
  await expect(renderStudioReelOnHost(input)).rejects.toThrow("scene media");
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.reserve).not.toHaveBeenCalled();
  mocks.reserve.mockRejectedValueOnce(new Error("Limit reached"));
  await expect(renderStudioReelOnHost(input)).rejects.toThrow("Limit reached");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
