import { describe, expect, it, vi } from "vitest";
import type { ContentProfile } from "./content-brain";
import {
  buildCreatorDiscover,
  inferDiscoverNiche,
  mergeDiscoverRefresh,
  storedDiscoverData,
  type CreatorDiscoverDependencies,
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

describe("personalized Discover", () => {
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
            canonicalUrl: "https://publisher.com/news",
            title: "New creator AI tools launch",
            summary: "A new workflow",
            sourceName: "Publisher",
            publishedAt: "2026-09-18T07:00:00.000Z",
            retrievedAt: "2026-09-18T08:00:00.000Z",
            kind: "youtube" as const,
            platform: "YouTube",
            author: "Creator Lab",
            stats: { views: 120_000, likes: 8_000, comments: 300 },
          },
        ],
        warnings: [],
      }),
      saveRecommendations,
    };
    const result = await buildCreatorDiscover("creator-id", deps, new Date("2026-09-18T09:00:00Z"));
    expect(deps.loadCreatorContext).toHaveBeenCalledWith("creator-id");
    expect(result.winners).toEqual([]);
    expect(result.trends[0]).toMatchObject({ sourceUrl: "https://publisher.com/news" });
    expect(result.trends[0].stats).toMatchObject({ views: 120_000, likes: 8_000 });
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
      sourceUrl: "https://example.com/story",
      sourceName: "Example",
      sourcePublishedAt: "2026-09-20T08:00:00.000Z",
      sourceRetrievedAt: "2026-09-20T09:00:00.000Z",
      reason: "Relevant to creator AI",
      angles: [],
      metricName: "views",
      metricValue: 1_000,
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
          nicheKey: "social-v5:creator ai",
          warnings: [],
          fetchedAt: "2026-09-20T09:00:00.000Z",
          expiresAt: "2026-09-21T09:00:00.000Z",
        },
        new Date("2026-09-20T10:00:00.000Z"),
      ).status,
    ).toBe("fresh");
  });

  it("keeps cached recommendations when a provider refresh returns nothing", () => {
    const cached = storedDiscoverData(
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          fingerprint: "trend:one",
          kind: "trend",
          title: "Cached creator story",
          summary: "Still useful",
          sourceUrl: "https://example.com/story",
          sourceName: "Example",
          sourcePublishedAt: "2026-09-20T08:00:00.000Z",
          sourceRetrievedAt: "2026-09-20T09:00:00.000Z",
          reason: "Relevant to creator AI",
          angles: [],
          metricName: "views",
          metricValue: 1_000,
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
    expect(result.trends).toEqual(cached.trends);
    expect(result.warnings).toEqual(refreshed.warnings);
  });
});
