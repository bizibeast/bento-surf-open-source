import { describe, expect, it, vi } from "vitest";
import type { ContentProfile } from "./content-brain";
import {
  buildCreatorDiscover,
  inferDiscoverNiche,
  mergeDiscoverRefresh,
  storedDiscoverData,
  type CreatorDiscoverDependencies,
  type DiscoverRecommendation,
  type RecommendationInput,
} from "./content-discovery.functions";
import type { SocialContentInsight } from "./social-content-insights.server";

const profile: ContentProfile = {
  goal: "consistent_publishing",
  nicheKeywords: ["creator AI"],
  language: "en",
  region: "global",
  timezone: "UTC",
  platformFrequencies: { linkedin: 3 },
};
const discoveryNow = new Date("2026-10-10T18:00:00Z");

function insight(id: string, impressions: number): SocialContentInsight & { id: string } {
  return {
    id,
    connectionId: "connection",
    provider: "linkedin",
    remotePostId: id,
    remotePostUrl: `https://linkedin.com/posts/${id}`,
    contentType: "text",
    caption:
      id === "creator-one"
        ? "Creator AI is changing workflows"
        : id === "other-creator"
          ? "Private other caption"
          : "Another creator AI workflow",
    thumbnailUrl: null,
    publishedAt: "2026-09-17T08:00:00.000Z",
    views: null,
    impressions,
    reach: null,
    engagements: 10,
    likes: 8,
    comments: 2,
    shares: null,
    saves: null,
    fetchedAt: "2026-09-18T08:00:00.000Z",
  };
}

function cachedPost(
  id: string,
  changes: Partial<DiscoverRecommendation> = {},
): DiscoverRecommendation {
  return {
    id,
    fingerprint: `trend:${id}`,
    kind: "trend",
    title: `Creator AI ${id}`,
    summary: "A recent creator AI workflow.",
    sourceUrl: `https://youtube.com/watch?v=${id}`,
    sourceName: "YouTube",
    platform: "YouTube",
    sourcePublishedAt: "2026-10-09T12:00:00Z",
    sourceRetrievedAt: "2026-10-10T12:00:00Z",
    reason: "Relevant to creator AI.",
    angles: [],
    metricName: "views",
    metricValue: 10_000,
    outlierScore: null,
    feedback: "pending",
    stats: { followers: 1_000, views: 10_000 },
    ...changes,
  };
}

describe("Discover admission quality", () => {
  it.each([
    {
      label: "small audience despite high views",
      changes: { stats: { followers: 999, views: 1_000_000 } },
    },
    {
      label: "unknown followers despite high views",
      changes: { stats: { followers: null, views: 1_000_000 } },
    },
    {
      label: "unknown traction despite a large audience",
      changes: { stats: { followers: 1_000_000 } },
    },
    {
      label: "reported zero traction",
      changes: { stats: { followers: 1_000, views: 0, likes: 0 } },
    },
    {
      label: "traction below both thresholds",
      changes: { stats: { followers: 1_000, views: 9_999, likes: 99 } },
    },
    { label: "unknown publication", changes: { sourcePublishedAt: null } },
    { label: "old publication", changes: { sourcePublishedAt: "2023-10-09T12:00:00Z" } },
    { label: "unsupported source", changes: { platform: "Web" } },
    {
      label: "Reddit without enough votes",
      changes: { platform: "Reddit", stats: { likes: 99, comments: 20 } },
    },
    {
      label: "Hacker News without enough comments",
      changes: { platform: "Hacker News", stats: { likes: 50, comments: 9 } },
    },
  ])("excludes cached posts with $label before display", ({ changes }) => {
    const result = storedDiscoverData([cachedPost("unqualified", changes)], null, discoveryNow);
    expect(result.trends).toEqual([]);
    expect(result.ideas).toEqual([]);
  });

  it("accepts observed social and community thresholds without inventing missing counts", () => {
    const sources = [
      cachedPost("view-threshold"),
      cachedPost("like-threshold", { stats: { followers: 1_000, views: 0, likes: 100 } }),
      cachedPost("reddit-threshold", { platform: "Reddit", stats: { likes: 100, comments: 10 } }),
      cachedPost("hn-threshold", { platform: "Hacker News", stats: { likes: 50, comments: 10 } }),
    ];
    const result = storedDiscoverData(sources, null, discoveryNow);
    expect(result.trends.map((item) => item.id).sort()).toEqual(
      sources.map((item) => item.id).sort(),
    );
    expect(
      result.trends.find((item) => item.id === "reddit-threshold")?.stats?.followers,
    ).toBeUndefined();
  });

  it("retains saved low-quality or unverified posts and ideas only in the saved library", () => {
    const savedPost = cachedPost("saved-low-audience", {
      saved: true,
      stats: { followers: 10, views: 1_000_000 },
    });
    const savedIdea = cachedPost("saved-unverified-idea", {
      kind: "idea",
      fingerprint: "idea:saved-unverified",
      feedback: "saved",
      sourcePublishedAt: null,
      stats: {},
      angles: ["An original angle saved for later"],
    });
    const unsaved = cachedPost("unsaved-low-audience", {
      stats: { followers: 10, views: 1_000_000 },
    });
    const result = storedDiscoverData([savedPost, savedIdea, unsaved], null, discoveryNow);
    expect(result.trends).toEqual([{ ...savedPost, savedOnly: true }]);
    expect(result.ideas).toEqual([{ ...savedIdea, savedOnly: true }]);
    expect([...result.trends, ...result.ideas].every((item) => item.savedOnly)).toBe(true);
  });

  it("rejects unqualified initial sources before generating ideas or saving recommendations", async () => {
    const qualified = {
      canonicalUrl: "https://youtube.com/watch?v=qualified",
      title: "Creator AI editing workflow",
      summary: "A practical recent demonstration.",
      sourceName: "YouTube",
      platform: "YouTube",
      kind: "youtube" as const,
      publishedAt: "2026-10-09T12:00:00Z",
      retrievedAt: discoveryNow.toISOString(),
      stats: { followers: 1_000, views: 10_000 },
    };
    const sources = [
      {
        ...qualified,
        canonicalUrl: "https://youtube.com/watch?v=low-followers",
        stats: { followers: 999, views: 10_000_000 },
      },
      {
        ...qualified,
        canonicalUrl: "https://youtube.com/watch?v=unknown-followers",
        stats: { views: 10_000_000 },
      },
      {
        ...qualified,
        canonicalUrl: "https://youtube.com/watch?v=unknown-traction",
        stats: { followers: 1_000_000 },
      },
      { ...qualified, canonicalUrl: "https://youtube.com/watch?v=undated", publishedAt: null },
      qualified,
    ];
    const generateIdeas = vi.fn().mockResolvedValue([]);
    const saveRecommendations = vi.fn(async (_userId: string, rows: RecommendationInput[]) =>
      rows.map((row) => ({ ...row, id: row.fingerprint, feedback: "pending" as const })),
    );
    const result = await buildCreatorDiscover(
      "owner",
      {
        loadCreatorContext: async () => ({
          profile,
          brainItems: [],
          insights: [],
          feedbackSeeds: [],
        }),
        getTrendBrief: vi
          .fn()
          .mockResolvedValue({ id: "quality-brief", items: sources, warnings: [] }),
        generateIdeas,
        saveRecommendations,
      },
      discoveryNow,
    );
    expect(generateIdeas).toHaveBeenCalledWith([qualified], expect.any(Object), discoveryNow);
    expect(result.trends.map((item) => item.sourceUrl)).toEqual([qualified.canonicalUrl]);
    expect(result.ideas).toEqual([]);
    expect(saveRecommendations).toHaveBeenCalledTimes(1);
    expect(saveRecommendations.mock.calls[0][1].map((item) => item.sourceUrl)).toEqual([
      qualified.canonicalUrl,
    ]);
  });
});

describe("personalized Discover", () => {
  it("excludes verified archive posts and saves distinct grounded creation briefs", async () => {
    const now = new Date("2026-10-10T18:00:00Z");
    const recent = {
      canonicalUrl: "https://youtube.com/watch?v=recent123",
      title: "Creator AI: a new editing workflow",
      summary: "A practical demonstration of creator AI editing.",
      sourceName: "YouTube",
      platform: "YouTube",
      kind: "youtube" as const,
      publishedAt: "2026-10-09T10:00:00Z",
      retrievedAt: now.toISOString(),
      stats: { followers: 12_000, views: 40_000 },
    };
    const generated = {
      sourceUrl: recent.canonicalUrl,
      title: "Test an AI-assisted edit against your usual workflow",
      summary: "Make a side-by-side comparison using one clip and report your own result.",
      angles: [
        "Show the same clip both ways",
        "Measure time spent",
        "Explain which edit you prefer",
      ],
      inspiration: {
        hook: "Does AI actually save editing time?",
        format: "Side-by-side video",
        outline: ["Choose one clip", "Record both workflows", "Compare the result"],
        whyNow: "Inspired by this week's workflow demonstration.",
      },
    };
    const deps = {
      loadCreatorContext: async () => ({
        profile,
        brainItems: [],
        insights: [],
        feedbackSeeds: [],
      }),
      getTrendBrief: async () => ({
        id: "brief",
        items: [
          {
            ...recent,
            canonicalUrl: "https://youtube.com/watch?v=archive123",
            publishedAt: "2023-04-23T12:00:10Z",
            stats: { followers: 1_000_000, views: 90_000_000 },
          },
          recent,
        ],
        warnings: [],
      }),
      generateIdeas: vi.fn(async () => [generated]),
      saveRecommendations: async (_userId: string, rows: RecommendationInput[]) =>
        rows.map((row) => ({ ...row, id: row.fingerprint, feedback: "pending" as const })),
    } as unknown as CreatorDiscoverDependencies;
    const result = await buildCreatorDiscover("owner", deps, now);
    expect(result.trends.map((item) => item.sourceUrl)).toEqual([recent.canonicalUrl]);
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]).toMatchObject(generated);
    expect(result.ideas[0].summary).not.toBe(result.trends[0].summary);
    expect(result.trends[0].outlierScore).toBeNull();
  });

  it("keeps successful topic results when tracked-creator research rejects", async () => {
    const source = {
      canonicalUrl: "https://youtube.com/watch?v=creator123",
      title: "Creator AI",
      summary: "A creator AI guide",
      sourceName: "YouTube",
      platform: "YouTube",
      kind: "youtube" as const,
      publishedAt: "2026-10-09T12:00:00Z",
      retrievedAt: "2026-10-10T12:00:00Z",
      stats: { followers: 12_000, views: 40_000 },
    };
    const deps = {
      loadCreatorContext: async () => ({
        profile,
        brainItems: [],
        insights: [],
        feedbackSeeds: [],
        creators: [
          {
            id: "follow",
            name: "Creator",
            profileUrl: "https://youtube.com/@creator",
            platform: "YouTube",
            topics: "creator AI",
            avatarUrl: null,
          },
        ],
      }),
      getTrendBrief: async () => ({ id: "brief", items: [source], warnings: [] }),
      getCreatorSources: async () => {
        throw new Error("Creator provider timed out");
      },
      saveRecommendations: async (_userId: string, rows: RecommendationInput[]) =>
        rows.map((row) => ({ ...row, id: row.fingerprint, feedback: "pending" as const })),
    } as unknown as CreatorDiscoverDependencies;
    const result = await buildCreatorDiscover("owner", deps, discoveryNow);
    expect(result.trends).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("timed out");
  });
  it("keeps verified same-day matches when a provider fails without inventing a fresh retrieval time", async () => {
    const retrievedAt = "2026-10-07T08:00:00Z";
    const source = {
      canonicalUrl: "https://www.linkedin.com/posts/founder_ai-tools",
      title: "Creator AI tools for a growing business",
      summary: "A real creator workflow",
      sourceName: "LinkedIn",
      platform: "LinkedIn",
      publishedAt: "2026-10-07T07:00:00Z",
      retrievedAt,
      kind: "social_search" as const,
      stats: { followers: 5_000, views: 12_000 },
    };
    const getCachedSources = vi.fn().mockResolvedValue([source]);
    const result = await buildCreatorDiscover(
      "owner",
      {
        loadCreatorContext: vi
          .fn()
          .mockResolvedValue({ profile, brainItems: [], insights: [], feedbackSeeds: [] }),
        getTrendBrief: vi.fn().mockResolvedValue({
          id: "today-topic-brief",
          items: [],
          warnings: ["X / LinkedIn: upstream unavailable (429)."],
        }),
        getCachedSources,
        saveRecommendations: vi.fn(async (_id, rows) =>
          rows.map((row: RecommendationInput) => ({
            ...row,
            id: row.fingerprint,
            feedback: "pending" as const,
          })),
        ),
      },
      discoveryNow,
    );
    expect(getCachedSources).toHaveBeenCalledWith("owner", "today-topic-brief");
    expect(result.trends[0]).toMatchObject({
      sourceUrl: source.canonicalUrl,
      sourceRetrievedAt: retrievedAt,
    });
    expect(result.warnings).toEqual([]);
    expect(result.ideas).toHaveLength(1);
  });
  it("keeps an interrupted transport response from crashing the feed merge", () => {
    expect(() => mergeDiscoverRefresh(undefined, undefined)).toThrow("Your current feed is safe");
  });
  it("keeps tracked creator posts and grounded ideas when general research sources fail", async () => {
    const creator = {
      id: "favorite",
      profileUrl: "https://www.facebook.com/founder",
      platform: "Facebook",
      name: "Founder",
      topics: "bootstrapping",
      avatarUrl: null,
    };
    const source = {
      canonicalUrl: "https://www.facebook.com/founder/posts/123",
      title: "How I funded the first product",
      summary: "A breakdown of early customer revenue.",
      sourceName: "Facebook",
      platform: "Facebook",
      author: "Founder",
      authorUrl: creator.profileUrl,
      publishedAt: "2026-10-07T09:00:00Z",
      retrievedAt: "2026-10-07T10:00:00Z",
      kind: "social_search" as const,
      stats: { followers: 2_000, likes: 250 },
    };
    const deps = {
      loadCreatorContext: vi.fn().mockResolvedValue({
        profile,
        brainItems: [],
        insights: [],
        feedbackSeeds: [],
        creators: [creator],
      }),
      getTrendBrief: vi
        .fn()
        .mockResolvedValue({ id: "brief", items: [], warnings: ["Social search: timeout"] }),
      getCreatorSources: vi.fn().mockResolvedValue([source]),
      saveRecommendations: vi.fn(async (_userId, rows) =>
        rows.map((row: RecommendationInput, index: number) => ({
          ...row,
          id: String(index),
          feedback: "pending" as const,
        })),
      ),
    };
    const result = await buildCreatorDiscover("owner", deps, discoveryNow);
    expect(result.trends[0]).toMatchObject({
      sourceUrl: source.canonicalUrl,
      relevanceScore: 39.5,
      reason: "From Founder, a creator you track. Your focus: bootstrapping.",
    });
    expect(result.ideas[0].angles.join(" ")).toContain("bootstrapping");
    expect(result.ideas[0].sourceUrl).toBe(source.canonicalUrl);
    deps.getCreatorSources.mockResolvedValueOnce([]);
    await expect(buildCreatorDiscover("owner", deps, discoveryNow)).rejects.toThrow(
      "Research could not finish",
    );
    expect(deps.saveRecommendations).toHaveBeenCalledTimes(1);
  });
  it("uses the creator's posts for niche inference but returns external public posts", async () => {
    const saveRecommendations: CreatorDiscoverDependencies["saveRecommendations"] = vi.fn(
      async (_userId, rows) =>
        rows.map((row: RecommendationInput, index: number) => ({
          id: `rec-${index}`,
          ...row,
          feedback: row.feedback || "pending",
        })),
    );
    const deps = {
      loadCreatorContext: vi.fn().mockResolvedValue({
        profile,
        brainItems: [],
        insights: [insight("creator-one", 1_000), insight("creator-two", 400)],
        feedbackSeeds: [],
      }),
      getTrendBrief: vi.fn().mockResolvedValue({
        id: "brief",
        nicheKey: "creator ai",
        nicheKeywords: profile.nicheKeywords,
        language: "en",
        region: "global",
        date: "2026-09-18",
        items: [
          {
            canonicalUrl: "https://www.youtube.com/watch?v=r0c7RhMFcww",
            title: "New creator AI tools launch",
            summary: "A new workflow",
            sourceName: "YouTube",
            publishedAt: "2026-09-18T07:00:00.000Z",
            retrievedAt: "2026-09-18T08:00:00.000Z",
            kind: "youtube" as const,
            platform: "YouTube",
            author: "Creator Lab",
            authorUrl: "https://www.youtube.com/@creatorlab",
            authorAvatarUrl: "https://yt3.ggpht.com/creator-avatar.jpg",
            thumbnailUrl: "https://i.ytimg.com/vi/r0c7RhMFcww/hqdefault.jpg",
            mediaType: "video",
            media: [{ type: "video", url: "https://cdn.example.com/post.mp4" }],
            stats: { followers: 20_000, views: 120_000, likes: 8_000, comments: 300 },
          },
        ],
        warnings: [],
      }),
      saveRecommendations,
    };
    const result = await buildCreatorDiscover("creator-id", deps, new Date("2026-09-18T09:00:00Z"));
    expect(deps.loadCreatorContext).toHaveBeenCalledWith("creator-id");
    expect(result.winners).toEqual([]);
    expect(result.trends[0]).toMatchObject({
      sourceUrl: "https://www.youtube.com/watch?v=r0c7RhMFcww",
    });
    expect(result.trends[0].stats).toMatchObject({ views: 120_000, likes: 8_000 });
    expect(result.trends[0]).toMatchObject({
      authorAvatarUrl: "https://yt3.ggpht.com/creator-avatar.jpg",
      authorUrl: "https://www.youtube.com/@creatorlab",
      mediaType: "video",
      media: [expect.objectContaining({ url: "https://cdn.example.com/post.mp4" })],
    });
    expect(result.ideas[0].angles).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("Private other caption");
    expect(saveRecommendations).toHaveBeenCalledTimes(1);
  });

  it("does not call public research until the creator has niche topics", async () => {
    const getTrendBrief = vi.fn();
    const result = await buildCreatorDiscover(
      "creator-id",
      {
        loadCreatorContext: vi.fn().mockResolvedValue({
          profile: { ...profile, nicheKeywords: [] },
          brainItems: [],
          insights: [],
          feedbackSeeds: [],
        }),
        getTrendBrief,
        saveRecommendations: vi.fn().mockResolvedValue([]),
      },
      new Date("2026-09-18T09:00:00Z"),
    );
    expect(getTrendBrief).not.toHaveBeenCalled();
    expect(result).toMatchObject({ winners: [], trends: [], ideas: [] });
  });

  it("learns niche keywords from creator posts and saved Discover feedback", () => {
    expect(
      inferDiscoverNiche({
        profile: { ...profile, nicheKeywords: [] },
        brainItems: [],
        insights: [insight("creator-one", 1_000), insight("creator-two", 400)],
        feedbackSeeds: [
          { title: "AI video agents for creators", summary: "Automated creator workflows" },
        ],
      }),
    ).toEqual(expect.arrayContaining(["creator", "agents", "workflows"]));
  });

  it("does not infer a niche from generic social copy", () => {
    const result = inferDiscoverNiche({
      profile: { ...profile, nicheKeywords: [] },
      brainItems: [],
      insights: [
        {
          ...insight("creator-one", 1_000),
          caption:
            "The video is in what you make every day for it to map creator AI agents and audience growth",
        },
        {
          ...insight("creator-two", 800),
          caption:
            "You can make the video that is in a map with no path to creator AI workflows and automation",
        },
      ],
      feedbackSeeds: [],
    });

    expect(result).toEqual(expect.arrayContaining(["ai", "creator", "agents"]));
    for (const generic of [
      "and",
      "day",
      "for",
      "in",
      "is",
      "it",
      "make",
      "no",
      "the",
      "to",
      "video",
      "you",
    ]) {
      expect(result).not.toContain(generic);
    }
  });

  it("weights the creator's best-performing posts above repeated low-performing noise", () => {
    const noisy = Array.from({ length: 12 }, (_, index) => ({
      ...insight(`noise-${index}`, 10),
      caption: "lifestyle fashion travel cooking music gaming",
    }));
    const result = inferDiscoverNiche({
      profile: { ...profile, nicheKeywords: [] },
      brainItems: [],
      insights: [
        ...noisy,
        {
          ...insight("winner", 100_000),
          caption: "creator AI agents automation",
        },
      ],
      feedbackSeeds: [],
    });

    expect(result).toEqual(expect.arrayContaining(["ai", "creator", "agents"]));
  });

  it("returns stored recommendations immediately while an old cache refreshes", () => {
    const recommendation = {
      id: "11111111-1111-4111-8111-111111111111",
      fingerprint: "trend:one",
      kind: "trend" as const,
      title: "Creator agents launch",
      summary: "A useful launch",
      sourceUrl: "https://youtube.com/watch?v=stored-story",
      sourceName: "YouTube",
      platform: "YouTube",
      stats: { followers: 12_000, views: 100_000 },
      sourcePublishedAt: "2026-09-20T08:00:00.000Z",
      sourceRetrievedAt: "2026-09-20T09:00:00.000Z",
      reason: "Relevant to creator AI",
      angles: [],
      metricName: "views",
      metricValue: 100_000,
      outlierScore: null,
      feedback: "pending" as const,
    };
    const result = storedDiscoverData(
      [recommendation],
      {
        nicheKey: "social-v2:creator ai",
        warnings: [],
        fetchedAt: "2026-09-20T09:00:00.000Z",
        expiresAt: "2026-09-21T09:00:00.000Z",
      },
      new Date("2026-09-20T10:00:00.000Z"),
    );

    expect(result.trends).toEqual([recommendation]);
    expect(result.status).toBe("stale");
    expect(result.lastRefreshedAt).toBe("2026-09-20T09:00:00.000Z");

    expect(
      storedDiscoverData(
        [recommendation],
        {
          nicheKey: "social-v15:creator ai",
          warnings: [],
          fetchedAt: "2026-09-20T09:00:00.000Z",
          expiresAt: "2026-09-21T09:00:00.000Z",
        },
        new Date("2026-09-20T10:00:00.000Z"),
      ).status,
    ).toBe("fresh");
  });

  it("does not relabel an old direction as fresh after a successful empty refresh", () => {
    const cached = storedDiscoverData(
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          fingerprint: "trend:one",
          kind: "trend",
          title: "Cached creator story",
          summary: "Still useful",
          sourceUrl: "https://youtube.com/watch?v=stored-story",
          sourceName: "YouTube",
          platform: "YouTube",
          stats: { followers: 12_000, views: 100_000 },
          sourcePublishedAt: "2026-09-20T08:00:00.000Z",
          sourceRetrievedAt: "2026-09-20T09:00:00.000Z",
          reason: "Relevant to creator AI",
          angles: [],
          metricName: "views",
          metricValue: 100_000,
          outlierScore: null,
          feedback: "pending",
        },
      ],
      {
        nicheKey: "social-v2:creator ai",
        warnings: [],
        fetchedAt: "2026-09-20T09:00:00.000Z",
        expiresAt: "2026-09-21T09:00:00.000Z",
      },
      new Date("2026-09-20T10:00:00.000Z"),
    );
    const refreshed = {
      ...cached,
      trends: [],
      ideas: [],
      warnings: ["4 sources were unavailable."],
      status: "fresh" as const,
    };
    const result = mergeDiscoverRefresh(cached, refreshed);
    expect(result.trends).toEqual([]);
    expect(result.warnings).toEqual(refreshed.warnings);
    const saved = { ...cached.trends[0], saved: true };
    expect(mergeDiscoverRefresh({ ...cached, trends: [saved] }, refreshed).trends).toEqual([
      { ...saved, savedOnly: true },
    ]);
  });

  it.each([
    { label: "topics", changed: { nicheKeywords: ["lifestyle"] } },
    { label: "language", changed: { language: "es" } },
    { label: "region", changed: { region: "in" } },
  ])(
    "does not resurrect old $label recommendations on reload after an empty refresh",
    async ({ changed }) => {
      const now = new Date("2026-10-10T18:00:00Z");
      const context = { profile, brainItems: [], insights: [], feedbackSeeds: [] };
      const oldDirection = storedDiscoverData([], null, now, context).directionKey!;
      const priorBrief = {
        nicheKey: oldDirection.split(":locale:")[0],
        language: profile.language,
        region: profile.region,
        warnings: [],
        fetchedAt: "2026-10-10T12:00:00Z",
        expiresAt: "2026-10-11T12:00:00Z",
      };
      const original: DiscoverRecommendation = {
        id: "old-post",
        fingerprint: "trend:old-post",
        kind: "trend",
        title: "Creator AI workflow",
        summary: "An existing creator AI recommendation.",
        sourceUrl: "https://youtube.com/watch?v=old-post",
        sourceName: "YouTube",
        platform: "YouTube",
        stats: { followers: 12_000, views: 100_000 },
        sourcePublishedAt: "2026-10-09T12:00:00Z",
        sourceRetrievedAt: priorBrief.fetchedAt,
        reason: "Matches the previous direction.",
        angles: [],
        metricName: null,
        metricValue: null,
        outlierScore: null,
        feedback: "pending",
      };
      // No rows from an empty refresh will replace the old brief pointer. Preserve
      // both bookmark representations while rejecting unsaved prior-direction rows.
      const persisted = [
        original,
        {
          ...original,
          id: "saved-post",
          fingerprint: "trend:saved",
          sourceUrl: "https://youtube.com/watch?v=saved",
          feedback: "saved" as const,
        },
        {
          ...original,
          id: "saved-idea",
          fingerprint: "idea:saved",
          sourceUrl: "https://youtube.com/watch?v=saved-idea",
          kind: "idea" as const,
          saved: true,
          angles: ["An original angle"],
        },
        {
          ...original,
          id: "rejected-reference",
          fingerprint: "trend:rejected",
          sourceUrl: "https://youtube.com/watch?v=rejected",
          feedback: "not_relevant" as const,
        },
        {
          ...original,
          id: "saved-rejected-idea",
          fingerprint: "idea:rejected",
          sourceUrl: "https://youtube.com/watch?v=rejected",
          kind: "idea" as const,
          saved: true,
        },
      ];
      const changedContext = { ...context, profile: { ...profile, ...changed } };
      const saveRecommendations = vi.fn().mockResolvedValue([]);
      const refreshed = await buildCreatorDiscover(
        "owner",
        {
          loadCreatorContext: vi.fn().mockResolvedValue(changedContext),
          getTrendBrief: vi
            .fn()
            .mockResolvedValue({ id: "empty-new-brief", items: [], warnings: [] }),
          saveRecommendations,
        },
        now,
      );
      expect(saveRecommendations).toHaveBeenCalledWith("owner", []);
      const merged = mergeDiscoverRefresh(
        storedDiscoverData(persisted, priorBrief, now, context),
        refreshed,
      );
      expect([...merged.trends, ...merged.ideas].every((item) => item.savedOnly)).toBe(true);
      expect(merged.dismissedPostKeys).toEqual(["youtube:rejected"]);

      const reloaded = storedDiscoverData(persisted, priorBrief, now, changedContext);
      expect(reloaded.status).toBe("stale");
      expect(reloaded.directionKey).toBe(refreshed.directionKey);
      expect(reloaded.dismissedPostKeys).toEqual(["youtube:rejected"]);
      expect(reloaded.trends).toEqual([{ ...persisted[1], savedOnly: true }]);
      expect(reloaded.ideas).toEqual([{ ...persisted[2], savedOnly: true }]);
    },
  );
});

it("keeps oversized provider text inside the database limits without discarding creator media", async () => {
  const saveRecommendations: CreatorDiscoverDependencies["saveRecommendations"] = vi.fn(
    async (_id, rows) =>
      rows.map((row: RecommendationInput, index: number) => ({
        ...row,
        id: String(index),
        feedback: "pending" as const,
      })),
  );
  const source = {
    canonicalUrl: "https://linkedin.com/posts/creator_ai-tools-activity-123456789",
    title: "Title ".repeat(100),
    summary: "Caption ".repeat(1000),
    sourceName: "LinkedIn",
    platform: "LinkedIn",
    stats: { followers: 12_000, likes: 240 },
    publishedAt: "2026-10-06T20:00:00Z",
    retrievedAt: "2026-10-07T00:00:00Z",
    kind: "social_search",
    authorAvatarUrl: "https://example.com/creator.jpg",
  };
  const result = await buildCreatorDiscover(
    "owner",
    {
      loadCreatorContext: async () => ({
        profile,
        brainItems: [],
        insights: [],
        feedbackSeeds: [],
      }),
      getTrendBrief: vi.fn().mockResolvedValue({ id: "brief", items: [source], warnings: [] }),
      saveRecommendations,
    },
    discoveryNow,
  );
  expect(result.trends).toHaveLength(1);
  for (const item of [...result.trends, ...result.ideas]) {
    expect(item.title.length).toBeLessThanOrEqual(300);
    expect(item.summary.length).toBeLessThanOrEqual(5000);
    expect(item.authorAvatarUrl).toBe(source.authorAvatarUrl);
  }
});

it("uses confirmed Brain profile, strategy, and writing context even with explicit topics", () => {
  const context = {
    profile: { ...profile, nicheKeywords: ["startup journey"] },
    brainItems: [
      {
        id: "brain",
        kind: "strategy" as const,
        title: "Writing strategy",
        content: "Copywriting and storytelling for bootstrapped founders",
        status: "confirmed" as const,
        provenance: "creator" as const,
        locked: false,
        sourceUrl: null,
        sourceRef: null,
        createdAt: "2026-10-01",
        updatedAt: "2026-10-01",
      },
    ],
    insights: [],
    feedbackSeeds: [],
  };
  expect(inferDiscoverNiche(context)).toContain("writing");
  expect(inferDiscoverNiche({ ...context, useBrainContext: false })).not.toContain("writing");
  expect(
    inferDiscoverNiche({
      ...context,
      brainItems: context.brainItems.map((item) => ({ ...item, status: "suggested" as const })),
    }),
  ).not.toContain("writing");
});

it("uses researched Brain subjects for searches and ranking, and honors exclusions", async () => {
  const sources = [
    {
      canonicalUrl: "https://youtube.com/watch?v=comedy",
      title: "Observational stand-up comedy",
      summary: "Character sketches and everyday humor",
      authorUrl: "https://youtube.com/@trevornoah",
      sourceName: "YouTube",
      platform: "YouTube",
      publishedAt: "2026-10-09T12:00:00Z",
      retrievedAt: "2026-10-10",
      kind: "social_search" as const,
      stats: { followers: 5_000_000, views: 100_000 },
    },
    {
      canonicalUrl: "https://youtube.com/watch?v=business",
      title: "Startup marketing",
      summary: "Founder storytelling",
      sourceName: "YouTube",
      platform: "YouTube",
      publishedAt: "2026-10-09T12:00:00Z",
      retrievedAt: "2026-10-10",
      kind: "social_search" as const,
      stats: { followers: 5_000_000, views: 100_000_000 },
    },
  ];
  const getTrendBrief = vi.fn().mockResolvedValue({ id: "brief", items: sources, warnings: [] });
  const result = await buildCreatorDiscover(
    "owner",
    {
      loadCreatorContext: async () => ({
        profile: { ...profile, nicheKeywords: [] },
        brainItems: [],
        insights: [],
        feedbackSeeds: [],
      }),
      personalizeContext: async (_userId, context) => ({
        ...context,
        research: { topics: ["comedy"], excludedTopics: ["startup journey"], creators: [] },
      }),
      getTrendBrief,
      saveRecommendations: async (_userId, rows) =>
        rows.map((row) => ({ ...row, id: row.fingerprint, feedback: "pending" })),
    },
    discoveryNow,
  );
  expect(getTrendBrief).toHaveBeenCalledWith(
    expect.objectContaining({
      nicheKeywords: ["comedy"],
      creatorNames: expect.arrayContaining(["Trevor Noah"]),
    }),
  );
  expect(result.trends.map((item) => item.title)).toEqual(["Observational stand-up comedy"]);
  expect(result.suggestedCreators?.map((item) => item.name)).not.toContain("Alex Hormozi");
});

it("marks a stored business feed stale when the Brain's direction changes to comedy", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const brainContext = {
    profile,
    brainItems: [],
    insights: [],
    feedbackSeeds: [],
    research: { topics: ["comedy"], excludedTopics: [], creators: [] },
  };
  const result = storedDiscoverData(
    [],
    {
      nicheKey: "social-v12:startup journey",
      warnings: [],
      fetchedAt: now.toISOString(),
      expiresAt: "2026-10-11T12:00:00Z",
    },
    now,
    brainContext,
  );
  expect(result.status).toBe("stale");
  expect(result.directionKey).toContain("comedy");
  expect(
    storedDiscoverData(
      [],
      {
        nicheKey: result.directionKey!.split(":locale:")[0],
        warnings: [],
        fetchedAt: now.toISOString(),
        expiresAt: "2026-10-11T12:00:00Z",
      },
      now,
      brainContext,
    ).status,
  ).toBe("fresh");
});

it("uses a new refresh direction when only locale changes", () => {
  const context = { profile, brainItems: [], insights: [], feedbackSeeds: [] };
  const current = storedDiscoverData([], null, new Date(), context);
  const changed = storedDiscoverData([], null, new Date(), {
    ...context,
    profile: { ...profile, language: "hi", region: "IN" },
  });
  expect(changed.directionKey).not.toBe(current.directionKey);
});
