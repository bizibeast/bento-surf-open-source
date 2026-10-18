import { beforeEach, expect, it, vi } from "vitest";
import { buildManualCandidates, onboardingBriefSchema } from "./brief";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  import: vi.fn(),
  resolve: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("./session.server", () => ({
  onboardingDb: {
    rpc: mocks.rpc,
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: "photo", source_url: "https://www.instagram.com/p/owned" },
          error: null,
        }),
      };
      return q;
    },
  },
}));
vi.mock("../content-media.server", () => ({ processContentMediaImportMessage: mocks.import }));
vi.mock("../content-agent-media.server", () => ({ resolveOwnedAgentMedia: mocks.resolve }));
vi.mock("../content-agent-preparation.server", () => ({ prepareAgentMessage: mocks.prepare }));
import {
  carryOnboardingDraftMedia,
  prepareOnboardingInstagramPhoto,
  validateOnboardingDraftMedia,
} from "./media.server";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue([
    { url: "https://cdn.bento.surf/owned.jpg", mimeType: "image/jpeg", size: 2000 },
  ]);
});
it("makes no import when the shared budget or claim denies the photo", async () => {
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  expect(await prepareOnboardingInstagramPhoto("workspace", "post")).toBeNull();
  expect(mocks.import).not.toHaveBeenCalled();
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it("rejects a cross-workspace claim before touching media", async () => {
  mocks.rpc.mockResolvedValue({ data: [{ id: "photo", user_id: "another", lease_id: "lease" }] });
  await expect(prepareOnboardingInstagramPhoto("workspace", "post")).rejects.toThrow(
    /another workspace/,
  );
  expect(mocks.import).not.toHaveBeenCalled();
});
it("imports one leased owned image and reuses durable ready media", async () => {
  mocks.rpc.mockResolvedValue({ data: [{ id: "photo", user_id: "workspace", lease_id: "lease" }] });
  const result = await prepareOnboardingInstagramPhoto("workspace", "post");
  expect(mocks.import).toHaveBeenCalledWith({
    kind: "content_media_import",
    id: "photo",
    userId: "workspace",
    leaseId: "lease",
  });
  expect(result).toMatchObject({
    mediaIds: ["photo"],
    mediaPreview: { mediaId: "photo", url: "https://cdn.bento.surf/owned.jpg" },
  });
  mocks.rpc.mockResolvedValue({ data: [{ id: "photo", user_id: "workspace", lease_id: null }] });
  await prepareOnboardingInstagramPhoto("workspace", "post");
  expect(mocks.import).toHaveBeenCalledOnce();
});
it("does not use a video or an oversized image", async () => {
  mocks.rpc.mockResolvedValue({ data: [{ id: "photo", user_id: "workspace", lease_id: null }] });
  for (const asset of [
    { mimeType: "video/mp4", size: 100 },
    { mimeType: "image/png", size: 9 * 1024 * 1024 },
  ]) {
    mocks.resolve.mockResolvedValue([asset]);
    expect(await prepareOnboardingInstagramPhoto("workspace", "post")).toBeNull();
  }
});
it("rejects a preview URL that differs from the owned asset", async () => {
  const candidates = {
    ...buildManualCandidates(onboardingBriefSchema.parse({})),
    drafts: [
      {
        title: "Draft",
        body: "Body",
        platform: "linkedin" as const,
        mediaIds: ["photo"],
        mediaPreview: {
          mediaId: "photo",
          url: "https://example.com/spoof.jpg",
          alt: "Photo",
          sourceUrl: null,
        },
      },
    ],
  };
  await expect(validateOnboardingDraftMedia("workspace", candidates)).rejects.toThrow(
    /photo changed/,
  );
});
it("prepares only the exact onboarding card returned by the attachment transaction", async () => {
  mocks.rpc.mockResolvedValue({ data: [{ message_id: "message", card_id: "onboarding-1" }] });
  await carryOnboardingDraftMedia("workspace", 3);
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith("workspace", "message", "onboarding-1");
});
