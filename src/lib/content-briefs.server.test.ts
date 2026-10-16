import { describe, expect, it, vi } from "vitest";
import type { ContentSourceItem } from "./content-sources.server";
import {
  discoverSearchQuery,
  fetchTrendSources,
  getOrBuildTrendBrief,
  normalizeNicheKey,
  sourceMatchesDiscoverNiche,
} from "./content-briefs.server";

const input = {
  nicheKeywords: ["AI agents", "creator economy"],
  language: "en",
  region: "global",
  date: "2026-09-18",
};

const story = {
  canonicalUrl: "https://example.com/story",
  title: "AI agents for creators launch",
  summary: "Summary",
  sourceName: "Example",
  publishedAt: "2026-09-18T08:00:00.000Z",
  retrievedAt: "2026-09-18T09:00:00.000Z",
  kind: "rss" as const,
};

describe("shared niche briefs", () => {
  it("does not buy searches when free sources already provide enough fresh relevant stories", async () => {
    const search = vi.fn();
    const reserveSearch = vi.fn();
    const free = Array.from({ length: 12 }, (_, index) => ({
      ...story,
      canonicalUrl: `https://example.com/story-${index}`,
      title: `AI agents new development ${index}`,
      publishedAt: new Date().toISOString(),
    }));
    await fetchTrendSources(input, {
      search,
      reserveSearch,
      youtube: vi.fn().mockResolvedValue(free),
      reddit: vi.fn().mockResolvedValue([]),
      hackerNews: vi.fn().mockResolvedValue([]),
    });
    expect(search).not.toHaveBeenCalled();
    expect(reserveSearch).not.toHaveBeenCalled();
  });
  it("treats a platform as recovered when another adapter delivers relevant posts", async () => {
    const brief = await getOrBuildTrendBrief(input, {
      readBrief: vi.fn().mockResolvedValue(null),
      fetchSources: vi.fn().mockResolvedValue([
        { status: "fulfilled", value: [{ ...story, platform: "Reddit" }] },
        { status: "rejected", reason: new Error("Reddit: upstream unavailable (502).") },
      ]),
      saveBrief: vi.fn(async (value) => ({ id: "brief", ...value })),
    });
    expect(brief.items).toHaveLength(1);
    expect(brief.warnings).toEqual([]);
  });
  it("anchors broad interests to the niche and excludes unrelated strategy posts", () => {
    const topics = ["startup journey", "writing style", "hustle", "strategy"];
    expect(
      sourceMatchesDiscoverNiche(
        {
          ...story,
          title: "Boeing B737 Pilot View | Startup and Take Off",
          summary: "Cockpit startup and flight to Paris.",
        },
        topics,
      ),
    ).toBe(false);
    expect(discoverSearchQuery(topics)).toContain('("startup journey" "strategy")');
    expect(
      sourceMatchesDiscoverNiche(
        { ...story, title: "Seadra strategy", summary: "Pokémon team strategy" },
        topics,
      ),
    ).toBe(false);
    expect(
      sourceMatchesDiscoverNiche(
        {
          ...story,
          title: "Lessons from a bootstrapped founder",
          summary: "How we found our first customers",
        },
        topics,
      ),
    ).toBe(true);
  });
  it("researches topics as alternatives instead of requiring every unrelated keyword", () => {
    expect(discoverSearchQuery(["AI agents", "startup journey"])).toBe(
      '"AI agents" OR ("startup journey" OR "founder story" OR "bootstrapped founder")',
    );
  });

  it("manual refresh bypasses partial cached briefs and records precise source failures", async () => {
    const deps = {
      readBrief: vi
        .fn()
        .mockResolvedValue({ id: "old", items: [story], warnings: ["Reddit blocked"] }),
      fetchSources: vi.fn().mockResolvedValue([{ status: "fulfilled", value: [story] }]),
      saveBrief: vi.fn(async (brief) => ({ id: "new", ...brief })),
    };
    expect((await getOrBuildTrendBrief({ ...input, forceRefresh: true }, deps)).warnings).toEqual(
      [],
    );
    expect(deps.fetchSources).toHaveBeenCalledOnce();
    deps.fetchSources.mockResolvedValueOnce([
      { status: "rejected", reason: new Error("Social search: timeout") },
    ]);
    expect((await getOrBuildTrendBrief({ ...input, forceRefresh: true }, deps)).warnings).toEqual([
      "Social search: timeout",
    ]);
    expect(deps.saveBrief).toHaveBeenCalledTimes(2);
  });
  it("normalizes equivalent niche keyword sets to one key", () => {
    expect(normalizeNicheKey([" Creator Economy ", "AI Agents"])).toBe(
      normalizeNicheKey(["ai agents", "creator economy"]),
    );
    expect(normalizeNicheKey(["creator AI"])).toMatch(/^social-v14:/);
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
    expect(brief.warnings).toContain("RSS down");
    expect(deps.saveBrief).toHaveBeenCalledTimes(1);
  });

  it("retains a larger balanced pool without letting one platform monopolize it", async () => {
    const platforms = [
      "YouTube",
      "Instagram",
      "TikTok",
      "LinkedIn",
      "X",
      "Threads",
      "Facebook",
      "Reddit",
      "Hacker News",
    ];
    const stories = Array.from({ length: 300 }, (_, index) => ({
      ...story,
      canonicalUrl: `https://example.com/${index}`,
      title: `AI agents for creators ${index}`,
      platform: platforms[index % platforms.length],
    }));
    const deps = {
      readBrief: vi.fn().mockResolvedValue(null),
      fetchSources: vi.fn().mockResolvedValue([{ status: "fulfilled" as const, value: stories }]),
      saveBrief: vi.fn(async (brief) => ({ id: "new", ...brief })),
    };
    const items = (await getOrBuildTrendBrief(input, deps)).items;
    expect(items).toHaveLength(96);
    expect(items.filter((item) => item.platform === "Hacker News")).toHaveLength(4);
    for (const platform of platforms.slice(0, -1))
      expect(items.filter((item) => item.platform === platform).length).toBeGreaterThanOrEqual(10);
  });

  it("caches enriched media with the source and keeps posts when enrichment is unavailable", async () => {
    const enriched = {
      ...story,
      thumbnailUrl: "https://example.com/cover.jpg",
      authorAvatarUrl: "https://example.com/author.jpg",
    };
    const deps = {
      readBrief: vi.fn().mockResolvedValue(null),
      fetchSources: vi.fn().mockResolvedValue([{ status: "fulfilled", value: [story] }]),
      enrichSources: vi.fn().mockResolvedValue([enriched]),
      saveBrief: vi.fn(async (brief) => ({ id: "new", ...brief })),
    };
    expect((await getOrBuildTrendBrief(input, deps)).items[0]).toEqual(enriched);
    deps.enrichSources.mockRejectedValueOnce(new Error("Source unavailable"));
    expect((await getOrBuildTrendBrief(input, deps)).items[0]).toEqual(story);
  });
});

it("expands narrow founder phrases and isolates briefs for different reference creators", () => {
  expect(discoverSearchQuery(["startup journey"])).toContain('"bootstrapped founder"');
  expect(discoverSearchQuery(["startup journey"])).toContain('"founder story"');
  expect(normalizeNicheKey(["startup journey"], ["Alex Hormozi"])).not.toBe(
    normalizeNicheKey(["startup journey"], ["Justin Welsh"]),
  );
});

it("matches each chosen interest independently without forcing startup context onto writing", () => {
  expect(
    sourceMatchesDiscoverNiche(
      {
        ...story,
        title: "Improve your copywriting",
        summary: "Clear hooks and storytelling for your readers.",
      },
      ["startup journey", "writing style"],
    ),
  ).toBe(true);
  expect(
    sourceMatchesDiscoverNiche(
      { ...story, title: "Boeing startup checklist", summary: "Engine startup before takeoff" },
      ["startup journey", "writing style"],
    ),
  ).toBe(false);
});

it("matches genre synonyms and keeps compound subjects specific", () => {
  expect(
    sourceMatchesDiscoverNiche(
      { ...story, title: "Observational stand-up", summary: "An everyday-life sketch" },
      ["comedy"],
    ),
  ).toBe(true);
  expect(
    sourceMatchesDiscoverNiche(
      { ...story, title: "A chef's favorite recipes", summary: "A new dish" },
      ["cooking"],
    ),
  ).toBe(true);
  expect(
    sourceMatchesDiscoverNiche(
      { ...story, title: "Coral reef restoration", summary: "Marine biology fieldwork" },
      ["coral reef restoration"],
    ),
  ).toBe(true);
  expect(
    sourceMatchesDiscoverNiche(
      { ...story, title: "Vintage car restoration", summary: "A new engine" },
      ["coral reef restoration"],
    ),
  ).toBe(false);
});

it("rotates two social platforms and widens sparse results within four paid requests", async () => {
  const search = vi.fn(async (query, options) => {
    expect(await options.reserve()).toBe(true);
    return query.windowDays === 7 ? [] : [{ ...story, platform: "Instagram" }];
  });
  const reserveSearch = vi.fn().mockResolvedValue(true);
  const hackerNews = vi.fn().mockResolvedValue([]);
  const results = await fetchTrendSources(
    { ...input, nicheKeywords: ["comedy"], creatorNames: ["Trevor Noah"] },
    {
      search,
      reserveSearch,
      youtube: vi.fn().mockResolvedValue([]),
      reddit: vi.fn().mockResolvedValue([]),
      hackerNews,
    },
  );
  expect(search).toHaveBeenCalledTimes(4);
  expect(reserveSearch).toHaveBeenCalledTimes(4);
  expect(search.mock.calls.filter(([query]) => query.windowDays === 7)).toHaveLength(2);
  expect(search.mock.calls.filter(([query]) => query.windowDays === 30)).toHaveLength(2);
  expect(new Set(search.mock.calls.slice(0, 2).map(([query]) => query.group)).size).toBe(2);
  expect(search.mock.calls[0][0]).toMatchObject({ limit: 20, query: '"comedy" OR "Trevor Noah"' });
  expect(hackerNews).not.toHaveBeenCalled();
  expect(results).toHaveLength(4);
});

it("counts transient retries against the same per-brief provider allowance", async () => {
  const accepted: boolean[] = [];
  const search = vi.fn(async (_query, options) => {
    accepted.push(await options.reserve());
    accepted.push(await options.reserve());
    return [];
  });
  const reserveSearch = vi.fn().mockResolvedValue(true);
  await fetchTrendSources(input, {
    search,
    reserveSearch,
    youtube: vi.fn().mockResolvedValue([]),
    reddit: vi.fn().mockResolvedValue([]),
    hackerNews: vi.fn().mockResolvedValue([]),
  });
  expect(reserveSearch).toHaveBeenCalledTimes(4);
  expect(accepted.filter(Boolean)).toHaveLength(4);
  expect(search).toHaveBeenCalledTimes(2);
});

it("rejects old posts before and after metadata enrichment and keeps undated posts honest", async () => {
  const old = {
    ...story,
    canonicalUrl: "https://example.com/old",
    title: "AI agents old viral hit",
    publishedAt: "2023-09-18T08:00:00Z",
    stats: { views: 10_000_000 },
  };
  const unknown = {
    ...story,
    canonicalUrl: "https://example.com/unknown",
    title: "AI agents date unknown",
    publishedAt: null,
  };
  const hiddenOld = {
    ...unknown,
    canonicalUrl: "https://example.com/enriched-old",
    title: "AI agents date revealed",
  };
  const enrichSources = vi.fn(async (items: ContentSourceItem[]) =>
    items.map((item) =>
      item.canonicalUrl === hiddenOld.canonicalUrl
        ? { ...item, publishedAt: old.publishedAt }
        : item,
    ),
  );
  const brief = await getOrBuildTrendBrief(input, {
    readBrief: vi.fn().mockResolvedValue(null),
    fetchSources: vi
      .fn()
      .mockResolvedValue([{ status: "fulfilled", value: [old, unknown, hiddenOld, story] }]),
    enrichSources,
    saveBrief: vi.fn(async (value) => ({ id: "brief", ...value })),
  });
  expect(enrichSources.mock.calls[0][0]).not.toContainEqual(old);
  expect(brief.items.map((item) => item.canonicalUrl)).toEqual([
    story.canonicalUrl,
    unknown.canonicalUrl,
  ]);
  expect(brief.items[1].publishedAt).toBeNull();
});

it("ranks a fresh breakout before a much bigger month-old lifetime total", async () => {
  const fresh = {
    ...story,
    canonicalUrl: "https://example.com/fresh",
    title: "AI agents breakout",
    platform: "YouTube",
    stats: { views: 10_000 },
  };
  const older = {
    ...story,
    canonicalUrl: "https://example.com/older",
    title: "AI agents established",
    platform: "YouTube",
    publishedAt: "2026-08-25T08:00:00Z",
    stats: { views: 50_000_000 },
  };
  const brief = await getOrBuildTrendBrief(input, {
    readBrief: vi.fn().mockResolvedValue(null),
    fetchSources: vi.fn().mockResolvedValue([{ status: "fulfilled", value: [older, fresh] }]),
    saveBrief: vi.fn(async (value) => ({ id: "brief", ...value })),
  });
  expect(brief.items.map((item) => item.canonicalUrl)).toEqual([
    fresh.canonicalUrl,
    older.canonicalUrl,
  ]);
});

it("does not let an archived duplicate headline suppress the recent post", async () => {
  const recent = { ...story, canonicalUrl: "https://example.com/new" };
  const older = {
    ...story,
    canonicalUrl: "https://example.com/old",
    publishedAt: "2023-09-18T08:00:00Z",
  };
  const brief = await getOrBuildTrendBrief(input, {
    readBrief: vi.fn().mockResolvedValue(null),
    fetchSources: vi.fn().mockResolvedValue([{ status: "fulfilled", value: [older, recent] }]),
    saveBrief: vi.fn(async (value) => ({ id: "brief", ...value })),
  });
  expect(brief.items.map((item) => item.canonicalUrl)).toEqual([recent.canonicalUrl]);
});

it("recognizes compound hashtags and typographic variants without broadening the subject", () => {
  expect(
    sourceMatchesDiscoverNiche({ ...story, title: "A new clip #standupcomedy", summary: "" }, [
      "stand-up comedy",
    ]),
  ).toBe(true);
  expect(
    sourceMatchesDiscoverNiche({ ...story, title: "𝗖𝗼𝗺𝗲𝗱𝘆 stories", summary: "" }, ["comedy"]),
  ).toBe(true);
  expect(
    sourceMatchesDiscoverNiche(
      { ...story, title: "Marine fieldwork #coralreefrestoration", summary: "" },
      ["coral reef restoration"],
    ),
  ).toBe(true);
  expect(
    sourceMatchesDiscoverNiche({ ...story, title: "A new vintage #carrestoration", summary: "" }, [
      "coral reef restoration",
    ]),
  ).toBe(false);
});

it("bounds long brief keys without collapsing differences beyond their readable prefix", () => {
  const sharedTopics = Array.from({ length: 12 }, (_, index) => `topic ${index} ${"a".repeat(45)}`);
  const creators = Array.from({ length: 8 }, (_, index) => `creator ${index} ${"b".repeat(30)}`);
  const first = normalizeNicheKey([...sharedTopics, "z final topic one"], creators);
  const second = normalizeNicheKey([...sharedTopics, "z final topic two"], creators);
  const third = normalizeNicheKey(
    [...sharedTopics, "z final topic one"],
    [...creators, "z final creator"],
  );
  expect(first.length).toBeLessThanOrEqual(500);
  expect(second.length).toBeLessThanOrEqual(500);
  expect(third.length).toBeLessThanOrEqual(500);
  expect(new Set([first, second, third]).size).toBe(3);
  expect(
    normalizeNicheKey([...sharedTopics, "z final topic one"].reverse(), creators.slice().reverse()),
  ).toBe(first);
  expect(normalizeNicheKey(["🎭".repeat(600)])).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});
