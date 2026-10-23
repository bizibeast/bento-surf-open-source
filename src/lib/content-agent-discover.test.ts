import { describe, expect, it } from "vitest";
import { mergeAgentDiscoverSources } from "./content-agent-discover";

describe("Discover evidence in Benny context", () => {
  const fresh = {
    title: "A current report",
    source_url: "https://example.com/news",
    source_published_at: "2026-10-22T04:00:00Z",
    summary: "Evidence from current reporting",
    feedback: "pending",
  };
  it("puts the shared brief before older saved recommendations and retains dates and links", () => {
    const result = mergeAgentDiscoverSources(
      [{ id: "old", sourceUrl: "https://example.com/old" }],
      [fresh],
    );
    expect(result[0]).toMatchObject({
      sourceUrl: fresh.source_url,
      sourcePublishedAt: fresh.source_published_at,
    });
    expect(result[1].id).toBe("old");
  });
  it("does not reintroduce a dismissed source through the shared brief or URL aliases", () => {
    expect(
      mergeAgentDiscoverSources(
        [{ sourceUrl: `${fresh.source_url}?utm_source=feed`, feedback: "not_relevant" }],
        [fresh],
      ),
    ).toEqual([]);
  });
  it("deduplicates current sources against saved cards while keeping creator feedback", () => {
    const result = mergeAgentDiscoverSources(
      [{ id: "saved", sourceUrl: fresh.source_url, feedback: "saved" }],
      [fresh],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "saved",
      feedback: "saved",
      sourcePublishedAt: fresh.source_published_at,
    });
  });
  it("bounds the combined context", () => {
    expect(
      mergeAgentDiscoverSources(
        Array.from({ length: 80 }, (_, i) => ({
          id: String(i),
          sourceUrl: `https://example.com/${i}`,
        })),
        [fresh],
      ),
    ).toHaveLength(50);
  });
});
