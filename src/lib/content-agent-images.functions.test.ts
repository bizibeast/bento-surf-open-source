import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  generate: vi.fn(),
  clear: vi.fn(),
  prefs: vi.fn(),
  access: vi.fn(),
  attach: vi.fn(),
  settings: vi.fn(),
  photos: vi.fn(),
  draft: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createServerFn: () => {
    let validator = (value: unknown) => value;
    const fn = {
      middleware: () => fn,
      validator: (v: typeof validator) => {
        validator = v;
        return fn;
      },
      handler: (handler: (v: unknown) => unknown) => (input?: { data: unknown }) =>
        handler({ context: { userId: "active-workspace" }, data: validator(input?.data) }),
    };
    return fn;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: m.access }));
vi.mock("./content-agent-images.server", () => ({
  generateDraftImage: m.generate,
  getImageWorkspaceState: m.settings,
  selectReferencePhotos: m.photos,
  getDraftImageState: m.draft,
  attachDraftImage: m.attach,
  clearDraftBackgrounds: m.clear,
}));
vi.mock("./content-agent-identity.server", () => ({
  getContentAgentPreferencesForWorkspace: m.prefs,
}));
import {
  draftImageInputSchema,
  requestDraftImage,
  attachAgentDraftImage,
  getContentImageSettings,
  getContentExistingPhotos,
  clearAgentDraftBackgrounds,
} from "./content-agent-images.functions";
const ref = { messageId: "70000000-0000-4000-8000-000000000001", cardId: "draft", revision: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  m.prefs.mockResolvedValue({ use_face_references: false, reference_photo_ids: ["photo"] });
  m.generate.mockResolvedValue({ id: "job", status: "queued" });
});
it("rejects caller-selected owners, reference IDs and URLs", () => {
  for (const extra of [
    { userId: "foreign" },
    { referenceIds: ["foreign"] },
    { url: "https://evil" },
  ])
    expect(
      draftImageInputSchema.safeParse({ draftRef: ref, requestKey: "a", ...extra }).success,
    ).toBe(false);
});
it("derives workspace from authentication and references from saved consent", async () => {
  await requestDraftImage({ data: { draftRef: ref, requestKey: "a" } });
  expect(m.access).toHaveBeenCalledWith("active-workspace");
  expect(m.generate).toHaveBeenCalledWith({
    userId: "active-workspace",
    draftRef: ref,
    requestKey: "a",
    referenceIds: [],
  });
  m.prefs.mockResolvedValue({ use_face_references: true, reference_photo_ids: ["approved"] });
  await requestDraftImage({ data: { draftRef: ref, requestKey: "b" } });
  expect(m.generate).toHaveBeenLastCalledWith(
    expect.objectContaining({ referenceIds: ["approved"] }),
  );
});
it("scopes existing photo reuse independently from provider consent", async () => {
  await getContentExistingPhotos();
  expect(m.photos).toHaveBeenCalledWith("active-workspace", false);
  await attachAgentDraftImage({ data: { draftRef: ref, mediaId: ref.messageId, slideIndex: 0 } });
  expect(m.attach).toHaveBeenCalledWith("active-workspace", ref, ref.messageId, 0);
});
it("returns workspace quota without secrets", async () => {
  await getContentImageSettings();
  expect(m.settings).toHaveBeenCalledWith("active-workspace");
});

it("scopes all-background repair to the authenticated workspace and expected revision", async () => {
  await clearAgentDraftBackgrounds({ data: ref });
  expect(m.access).toHaveBeenCalledWith("active-workspace");
  expect(m.clear).toHaveBeenCalledWith("active-workspace", ref);
});
