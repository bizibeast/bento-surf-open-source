import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_BRANDING } from "./content-agent-branding";
const owner = "10000000-0000-4000-8000-000000000001";
const messageId = "10000000-0000-4000-8000-000000000002";
const photo = "10000000-0000-4000-8000-000000000003";
const mocks = vi.hoisted(() => ({
  payload: {} as any,
  photos: [] as any[],
  rpc: vi.fn(),
  resolve: vi.fn(),
  register: vi.fn(),
  render: vi.fn(),
  store: vi.fn(),
}));
function query(table: string) {
  const q: any = {};
  for (const name of ["select", "eq", "gt", "in", "order", "update"]) q[name] = vi.fn(() => q);
  q.single = async () => ({ data: { payload: mocks.payload }, error: null });
  q.limit = async () => ({
    data: table === "creator_content_media" ? mocks.photos : [],
    error: null,
  });
  return q;
}
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: query, rpc: mocks.rpc },
}));
vi.mock("./content-agent-media.server", () => ({
  resolveOwnedAgentMedia: mocks.resolve,
  registerAgentMedia: mocks.register,
}));
vi.mock("./content-media.server", () => ({ storeGeneratedContentMedia: mocks.store }));
vi.mock("./r2-storage.server", () => ({ getMediaBucket: () => ({ head: async () => null }) }));
vi.mock("./content-carousel-render.server", () => ({ renderAgentCarouselSlide: mocks.render }));
import { prepareAgentMessage, rankAgentPhotos } from "./content-agent-preparation.server";
const draft = {
  type: "draft" as const,
  cardId: "draft",
  platform: "linkedin" as const,
  format: "post" as const,
  title: "A better launch",
  body: "Launch one useful feature.",
  visualBrief: null,
  sourceUrls: [],
  rationale: "Grounded in the creator's work.",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.payload = { action: "draft", message: "Review this", cards: [draft] };
  mocks.photos = [];
  mocks.resolve.mockImplementation(async (_user: string, ids: string[]) =>
    ids.map((id) => ({
      key: `users/${owner}/${id}.jpg`,
      mimeType: "image/jpeg",
      size: 100,
      url: "https://test.example/photo",
      name: "Photo",
    })),
  );
  mocks.render.mockResolvedValue(new Uint8Array([1, 2]));
  mocks.register.mockImplementation(
    async (_u, _k, _s, provenance) => `20000000-0000-4000-8000-00000000000${provenance.slideIndex}`,
  );
  mocks.rpc.mockImplementation(async (name, input) => {
    if (name === "reserve_content_agent_media_plan")
      return {
        data: {
          id: messageId,
          branding: DEFAULT_AGENT_BRANDING,
          photo_required: mocks.payload.cards[0].platform === "linkedin",
        },
        error: null,
      };
    if (name === "mutate_content_agent_draft") {
      const state = {
        ...input.p_patch,
        revision: input.p_revision + 1,
        ...(input.p_patch.exportRevision !== undefined
          ? { exportRevision: input.p_revision + 1 }
          : {}),
      };
      mocks.payload.draftStates = { draft: state };
      return { data: state, error: null };
    }
    return { data: null, error: null };
  });
});
it("attaches an intact owned relevant photo before marking a LinkedIn draft ready", async () => {
  mocks.photos = [{ id: photo, caption: "Launch lessons from our workshop", tags: ["launch"] }];
  const result = await prepareAgentMessage(owner, messageId);
  expect(result.draftStates?.draft).toMatchObject({
    mediaIds: [photo],
    photoRequired: true,
    preparation: "ready",
  });
  const call = mocks.rpc.mock.calls.find(([name]) => name === "mutate_content_agent_draft")!;
  expect(call[1]).toMatchObject({
    p_user_id: owner,
    p_message_id: messageId,
    p_operation: "prepare",
    p_media: [{ key: `users/${owner}/${photo}.jpg` }],
  });
  expect(mocks.render).not.toHaveBeenCalled();
});
it("creates an original branded image when no relevant owned photo exists", async () => {
  const result = await prepareAgentMessage(owner, messageId);
  expect(result.draftStates?.draft).toMatchObject({
    photoRequired: true,
    preparation: "ready",
  });
  expect(result.draftStates?.draft.mediaIds).toHaveLength(1);
  expect(mocks.render).toHaveBeenCalledOnce();
  expect(mocks.store).toHaveBeenCalledOnce();
});
it("renders and stores all slides in order, then skips completed preparation on retries", async () => {
  mocks.payload.cards = [
    {
      ...draft,
      platform: "instagram",
      format: "carousel",
      slides: [
        { heading: "One useful idea", body: "Start small." },
        { heading: "Try it today", body: "Pick one change." },
      ],
    },
  ];
  const result = await prepareAgentMessage(owner, messageId);
  expect(result.draftStates?.draft).toMatchObject({
    revision: 1,
    exportRevision: 1,
    preparation: "ready",
  });
  expect(result.draftStates?.draft.mediaIds).toHaveLength(2);
  expect(mocks.render.mock.calls.map(([input]) => input.index)).toEqual([0, 1]);
  expect(mocks.store).toHaveBeenCalledTimes(2);
  await prepareAgentMessage(owner, messageId);
  expect(mocks.render).toHaveBeenCalledTimes(2);
});
it("does not call a partial carousel ready when rendering fails", async () => {
  mocks.payload.cards = [
    {
      ...draft,
      platform: "instagram",
      format: "carousel",
      slides: [
        { heading: "Cover", body: "Start small." },
        { heading: "Try it", body: "Next step." },
      ],
    },
  ];
  mocks.render.mockRejectedValue(new Error("Storage is temporarily unavailable."));
  const result = await prepareAgentMessage(owner, messageId);
  expect(result.draftStates?.draft).toMatchObject({ preparation: "visuals_needed", mediaIds: [] });
  expect(result.draftStates?.draft.exportRevision).toBeUndefined();
});
it("rotates equally relevant photos and rejects unrelated indexed images", () => {
  const rows = [
    { id: "a", caption: "Launch photo", tags: [] },
    { id: "b", caption: "Launch photo", tags: [] },
    { id: "c", caption: "Dinner", tags: [] },
  ];
  expect(rankAgentPhotos(rows, draft, null, ["a", "a"])).toEqual(["b", "a"]);
  expect(rankAgentPhotos(rows, draft, "c", ["c"])[0]).toBe("c");
});
