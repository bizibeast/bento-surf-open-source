import { describe, expect, it, vi } from "vitest";
import {
  contentSourceFingerprint,
  existingIndexedBrainItem,
  processDueContentIndexes,
  sourceBackedBrainItems,
  type ContentIndexDependencies,
} from "./content-index.server";
import type { BrainItem, BrainSuggestion } from "./content-brain";
const post = {
  connection_id: "connection",
  provider: "instagram",
  remote_post_id: "post-1",
  remote_post_url: "https://instagram.com/p/one",
  caption: "I built a creator tool after losing my old link page.",
  media_sources: [],
};
const suggestion: BrainSuggestion = {
  kind: "story",
  title: "Building a creator tool",
  content: "A sourced story.",
  provenance: "social_post",
  sourceRef: "instagram:post-1",
  evidence: [{ sourceRef: "instagram:post-1", quote: "I built a creator tool" }],
};
function dependencies(): ContentIndexDependencies {
  return {
    claim: vi
      .fn()
      .mockResolvedValue([
        { user_id: "owner", lease_id: "lease", requested_at: "2026-10-01T00:00:00Z" },
      ]),
    load: vi.fn().mockResolvedValue({ posts: [post], existing: [] }),
    generate: vi.fn().mockResolvedValue([suggestion]),
    indexMedia: vi.fn(),
    cacheMedia: vi.fn(),
    save: vi.fn(),
    finish: vi.fn(),
  };
}
describe("automatic connected-source indexing", () => {
  it("indexes source metadata and builds a Brain without a user pressing Build Brain", async () => {
    const deps = dependencies();
    expect(await processDueContentIndexes(deps)).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(deps.indexMedia).toHaveBeenCalledWith("owner", [post]);
    expect(deps.save).toHaveBeenCalledWith(
      "owner",
      [],
      [expect.objectContaining({ sourceRef: "instagram:post-1", sourceUrl: post.remote_post_url })],
    );
  });
  it("skips repeated AI work for an unchanged corpus but continues durable media work", async () => {
    const deps = dependencies();
    vi.mocked(deps.claim).mockResolvedValue([
      { user_id: "owner", source_fingerprint: await contentSourceFingerprint([post]) },
    ]);
    await processDueContentIndexes(deps);
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.cacheMedia).toHaveBeenCalledWith("owner");
  });
  it("rejects fabricated evidence and keeps creator corrections identifiable", () => {
    expect(
      sourceBackedBrainItems(
        [post],
        [
          {
            ...suggestion,
            evidence: [{ sourceRef: "instagram:post-1", quote: "I raised a million dollars" }],
          },
        ],
      ),
    ).toEqual([]);
    const existing = {
      ...suggestion,
      id: "item",
      status: "confirmed",
      locked: true,
      provenance: "creator",
      sourceUrl: null,
      createdAt: "",
      updatedAt: "",
    } as BrainItem;
    expect(existingIndexedBrainItem([existing], suggestion)).toBe(existing);
  });
  it("isolates a failed creator and leaves source data available for retry", async () => {
    const deps = dependencies();
    vi.mocked(deps.claim).mockResolvedValue([{ user_id: "owner" }, { user_id: "other" }]);
    vi.mocked(deps.generate)
      .mockRejectedValueOnce(new Error("Provider temporarily unavailable"))
      .mockResolvedValueOnce([suggestion]);
    expect(await processDueContentIndexes(deps)).toEqual({ claimed: 2, succeeded: 1, failed: 1 });
    expect(deps.finish).toHaveBeenCalledWith(
      { user_id: "owner" },
      expect.objectContaining({ error: "Provider temporarily unavailable" }),
    );
  });
});
