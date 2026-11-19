import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
import { studioStarter } from "./content-studio";

const mocks = vi.hoisted(() => ({
  rows: {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
  },
  rpc: vi.fn(),
  bucket: { head: vi.fn(), put: vi.fn() },
  render: vi.fn(),
  loadPhoto: vi.fn(),
  renderReel: vi.fn(),
  reelEnabled: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => mocks.rows, rpc: mocks.rpc },
}));
vi.mock("./content-studio.server", () => ({ requireStudioWorkspace: vi.fn() }));
vi.mock("./content-carousel-render.server", () => ({ renderAgentCarouselSlide: mocks.render }));
vi.mock("./studio-carousel-photo.server", () => ({ loadStudioCarouselPhoto: mocks.loadPhoto }));
vi.mock("./studio-reel-host.server", () => ({
  hostedStudioReelAttemptCost: mocks.reelEnabled,
  renderStudioReelOnHost: mocks.renderReel,
}));
vi.mock("./plan.server", () => ({
  getPlan: vi.fn(async () => "creator"),
  getStorageAllowanceMb: vi.fn(async () => 50),
}));
vi.mock("./r2-storage.server", () => ({
  getMediaBucket: () => mocks.bucket,
  sumR2UserStorageBytes: vi.fn(),
  mediaObjectUrl: (key: string) => `https://bento.surf/cdn/${key}`,
}));
vi.mock("./r2-usage-cache.server", () => ({
  cachedR2UserStorageBytes: vi.fn(async () => 0),
  adjustCachedR2UserStorageBytes: vi.fn(async () => undefined),
}));

import { processStudioCarouselMessage } from "./studio-carousel-jobs.server";

const workspace = "00000000-0000-4000-8000-000000000011";
const jobId = "00000000-0000-4000-8000-000000000012";
const message = { kind: "studio_carousel_render" as const, jobId };
const document = studioStarter("carousel", "editorial", DEFAULT_AGENT_BRANDING).document;

describe("hosted carousel export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BENTO_V2_STUDIO_SERVER_CAROUSELS", "true");
    vi.stubGlobal("__env__", { CONTENT_MEDIA_QUEUE: { send: vi.fn() } });
    mocks.rows.maybeSingle.mockReset();
    mocks.reelEnabled.mockReset().mockReturnValue(false);
    mocks.rpc.mockResolvedValue({ data: "00000000-0000-4000-8000-000000000018", error: null });
    mocks.bucket.head.mockResolvedValue(null);
    mocks.render.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("claims a saved text carousel, stores the ordered media, and completes once", async () => {
    mocks.rows.maybeSingle
      .mockResolvedValueOnce({ data: { id: jobId, status: "queued", attempts: 0 }, error: null })
      .mockResolvedValueOnce({
        data: { id: jobId, workspace_id: workspace, title: "Carousel", document, attempts: 1 },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: jobId }, error: null })
      .mockResolvedValueOnce({ data: { id: jobId, status: "ready", attempts: 1 }, error: null });
    await expect(processStudioCarouselMessage(message)).resolves.toBe("ack");
    await expect(processStudioCarouselMessage(message)).resolves.toBe("ack");
    expect(mocks.bucket.put).toHaveBeenCalledWith(
      `users/${workspace}/image/studio-${jobId}-1.png`,
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: expect.objectContaining({ contentType: "image/png" }),
      }),
    );
    expect(mocks.render).toHaveBeenCalledTimes(
      document.format === "carousel" ? document.slides.length : 0,
    );
    expect(mocks.rows.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ready" }),
    );
  });

  it("defers duplicate deliveries while a lease is active", async () => {
    mocks.rows.maybeSingle.mockResolvedValue({
      data: {
        id: jobId,
        status: "rendering",
        attempts: 1,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      error: null,
    });
    await expect(processStudioCarouselMessage(message)).resolves.toBe("retry");
    expect(mocks.rows.update).not.toHaveBeenCalled();
    expect(mocks.bucket.put).not.toHaveBeenCalled();
  });

  it("uses a workspace-owned photo once the photo switch is enabled", async () => {
    if (document.format !== "carousel") throw new Error("Expected a carousel fixture.");
    vi.stubEnv("BENTO_V2_STUDIO_SERVER_CAROUSEL_PHOTOS", "true");
    const photo = "00000000-0000-4000-8000-000000000019";
    const key = `users/${workspace}/image/portrait.jpg`;
    const portrait = { mime: "image/jpeg", base64: "jpeg" };
    mocks.loadPhoto.mockResolvedValue(portrait);
    mocks.rows.limit.mockResolvedValue({ data: [{ id: photo, storage_key: key }], error: null });
    mocks.rows.maybeSingle
      .mockResolvedValueOnce({ data: { id: jobId, status: "queued", attempts: 0 }, error: null })
      .mockResolvedValueOnce({
        data: {
          id: jobId,
          workspace_id: workspace,
          title: "Carousel",
          document: {
            ...document,
            brand: { ...document.brand, coverStyle: "portrait", heroPhotoId: photo },
          },
          attempts: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: jobId }, error: null });
    await expect(processStudioCarouselMessage(message)).resolves.toBe("ack");
    expect(mocks.rows.eq).toHaveBeenCalledWith("user_id", workspace);
    expect(mocks.rows.limit).toHaveBeenCalledWith(1);
    expect(mocks.loadPhoto).toHaveBeenCalledOnce();
    expect(mocks.loadPhoto).toHaveBeenCalledWith(mocks.bucket, workspace, key);
    expect(mocks.render).toHaveBeenNthCalledWith(1, expect.objectContaining({ portrait }));
    expect(mocks.render).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ portrait: undefined }),
    );
  });

  it("renders a saved Reel, registering the MP4 in the existing Media library", async () => {
    mocks.reelEnabled.mockReturnValue(true);
    const document = studioStarter("reel", "jump-cut", DEFAULT_AGENT_BRANDING).document;
    mocks.renderReel.mockResolvedValue(new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]));
    mocks.rows.maybeSingle
      .mockResolvedValueOnce({ data: { id: jobId, status: "queued", attempts: 0 }, error: null })
      .mockResolvedValueOnce({
        data: {
          id: jobId,
          workspace_id: workspace,
          requested_by: workspace,
          title: "Reel",
          document,
          attempts: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: jobId }, error: null });
    await expect(processStudioCarouselMessage(message)).resolves.toBe("ack");
    expect(mocks.renderReel).toHaveBeenCalledWith(
      expect.objectContaining({ document, authUserId: workspace, workspaceId: workspace }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "register_creator_uploaded_media",
      expect.objectContaining({
        p_key: `users/${workspace}/video/studio-${jobId}.mp4`,
        p_mime: "video/mp4",
      }),
    );
    expect(mocks.rows.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ready" }),
    );
  });
});
