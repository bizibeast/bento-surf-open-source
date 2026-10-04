import { describe, expect, it, vi } from "vitest";
import { getOrBuildTrendBrief, normalizeNicheKey } from "./content-briefs.server";

const input = {
  nicheKeywords: ["AI agents", "creator economy"],
  language: "en",
  region: "global",
  date: "2026-09-18",
};

const story = {
  canonicalUrl: "https://example.com/story",
  title: "Creator agents launch",
  summary: "Summary",
  sourceName: "Example",
  publishedAt: "2026-09-18T08:00:00.000Z",
  retrievedAt: "2026-09-18T09:00:00.000Z",
  kind: "rss" as const,
};

describe("shared niche briefs", () => {
  it("normalizes equivalent niche keyword sets to one key", () => {
    expect(normalizeNicheKey([" Creator Economy ", "AI Agents"])).toBe(
      normalizeNicheKey(["ai agents", "creator economy"]),
    );
    expect(normalizeNicheKey(["creator AI"])).toMatch(/^social-v5:/);
  });

  it("reuses one fresh brief for the same niche, language, region, and day", async () => {
    const existing = {
      id: "brief",
      ...input,
      nicheKey: normalizeNicheKey(input.nicheKeywords),
      items: [story],
      warnings: [],
    };
    const deps = {
      readBrief: vi.fn().mockResolvedValue(existing),
      fetchSources: vi.fn(),
      saveBrief: vi.fn(),
    };
    await expect(getOrBuildTrendBrief(input, deps)).resolves.toEqual(existing);
    expect(deps.fetchSources).not.toHaveBeenCalled();
  });

  it("keeps successful sources when one official source fails", async () => {
    const deps = {
      readBrief: vi.fn().mockResolvedValue(null),
      fetchSources: vi.fn().mockResolvedValue([
        { status: "fulfilled" as const, value: [story] },
        { status: "rejected" as const, reason: new Error("RSS down") },
      ]),
      saveBrief: vi.fn(async (brief) => ({ id: "new", ...brief })),
    };
    const brief = await getOrBuildTrendBrief(input, deps);
    expect(brief.items).toEqual([story]);
    expect(brief.warnings).toContain("One source was unavailable.");
    expect(deps.saveBrief).toHaveBeenCalledTimes(1);
  });

  it("stores at most fifty deduplicated source items", async () => {
    const stories = Array.from({ length: 60 }, (_, index) => ({
      ...story,
      canonicalUrl: `https://example.com/${index}`,
      title: `Story ${index}`,
    }));
    const deps = {
      readBrief: vi.fn().mockResolvedValue(null),
      fetchSources: vi.fn().mockResolvedValue([{ status: "fulfilled" as const, value: stories }]),
      saveBrief: vi.fn(async (brief) => ({ id: "new", ...brief })),
    };
    expect((await getOrBuildTrendBrief(input, deps)).items).toHaveLength(50);
  });
});
