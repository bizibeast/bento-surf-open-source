import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  head: vi.fn(),
  upsert: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) q[m] = () => q;
      q.upsert = (value: unknown) => {
        mocks.upsert(value);
        return q;
      };
      q.single = async () => ({ data: { id: "registered" } });
      q.then = (fn: (value: unknown) => unknown) => Promise.resolve({ data: mocks.rows }).then(fn);
      return q;
    },
  },
}));
vi.mock("./r2-storage.server", () => ({
  getMediaBucket: () => ({ head: mocks.head }),
  mediaObjectUrl: (key: string) => `https://bento.surf/cdn/${key}`,
  validateMediaObjectKey: (key: string) => (key.includes("..") ? null : key),
}));
import { registerAgentMedia, resolveOwnedAgentMedia } from "./content-agent-media.server";
const provenance = { messageId: "message", cardId: "draft", revision: 2, slideIndex: 0 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.head.mockResolvedValue({ size: 42, httpMetadata: { contentType: "image/jpeg" } });
});
describe("owned Agent media", () => {
  it("registers actual storage metadata and rejects another workspace", async () => {
    await expect(
      registerAgentMedia("second", "users/first/image.jpg", "carousel_export", provenance),
    ).rejects.toThrow("different workspace");
    expect(mocks.head).not.toHaveBeenCalled();
    expect(
      await registerAgentMedia("second", "users/second/image.jpg", "carousel_export", provenance),
    ).toBe("registered");
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "second",
        byte_size: 42,
        mime_type: "image/jpeg",
        draft_revision: 2,
        slide_index: 0,
      }),
    );
  });
  it("preserves requested order and rejects partial library matches", async () => {
    mocks.rows = [
      { id: "b", storage_key: "users/second/b.jpg", mime_type: "image/jpeg", byte_size: 42 },
      { id: "a", storage_key: "users/second/a.jpg", mime_type: "image/jpeg", byte_size: 42 },
    ];
    expect((await resolveOwnedAgentMedia("second", ["a", "b"])).map((m) => m.key)).toEqual([
      "users/second/a.jpg",
      "users/second/b.jpg",
    ]);
    await expect(resolveOwnedAgentMedia("second", ["missing"])).rejects.toThrow("no longer owned");
    await expect(resolveOwnedAgentMedia("second", ["a", "a"])).rejects.toThrow("unique");
  });
  it("rejects deleted objects and changed byte size or mime", async () => {
    mocks.rows = [
      { id: "a", storage_key: "users/second/a.jpg", mime_type: "image/jpeg", byte_size: 45 },
    ];
    await expect(resolveOwnedAgentMedia("second", ["a"])).rejects.toThrow("changed or is missing");
    mocks.head.mockResolvedValue(null);
    await expect(
      registerAgentMedia("second", "users/second/a.jpg", "carousel_export", provenance),
    ).rejects.toThrow("complete JPEG");
  });
});
