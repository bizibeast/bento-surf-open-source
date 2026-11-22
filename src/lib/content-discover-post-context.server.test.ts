import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  upsert: vi.fn(),
  requireContentWorkspace: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./content-access.server", () => ({
  requireContentWorkspace: mocks.requireContentWorkspace,
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: mocks.rateLimit }));

import {
  loadDiscoverPostContext,
  saveAnalyticsPostSource,
} from "./content-discover-post-context.server";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const otherWorkspace = "00000000-0000-4000-8000-000000000002";
const ideaId = "10000000-0000-4000-8000-000000000001";
const sourceId = "10000000-0000-4000-8000-000000000002";
const sourceUrl = "https://twitter.com/ada/status/42?utm_source=saved";
const analyticsReference = {
  connectionId: "00000000-0000-4000-8000-000000000003",
  remotePostId: "42",
};
const analyticsPost = {
  id: sourceId,
  user_id: workspaceId,
  connection_id: analyticsReference.connectionId,
  remote_post_id: analyticsReference.remotePostId,
  provider: "twitter",
  caption: "Our published caption\nStored post details",
  remote_post_url: sourceUrl,
  published_at: "2026-10-07T10:00:00Z",
  fetched_at: "2026-10-08T10:00:00Z",
  views: null,
  likes: 0,
  comments: 5,
  shares: null,
  saves: null,
};
const source = {
  user_id: workspaceId,
  id: sourceId,
  kind: "trend",
  title: "The original creator post",
  summary: "The cached excerpt",
  source_url: sourceUrl,
  source_published_at: "2026-10-07T10:00:00Z",
  source_retrieved_at: "2026-10-08T10:00:00Z",
  source_name: "X",
  metadata: { author: "Ada", stats: { views: null, likes: 120, comments: 0 } },
};
const idea = {
  ...source,
  id: ideaId,
  kind: "idea",
  title: "Draft idea",
  summary: "Proposed text",
  angles: ["My alternative"],
  metadata: { inspiration: { hook: "A suggested hook", outline: ["Try it"] } },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockImplementation((table) => {
    const rows =
      table === "social_content_insights"
        ? [analyticsPost]
        : [idea, source, { ...source, user_id: otherWorkspace, summary: "Another brand" }];
    let filtered = rows as Array<Record<string, unknown>>;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        filtered = filtered.filter((row) => row[key] === value);
        return query;
      },
      order: () => query,
      limit: () => query,
      upsert: (data: unknown, options: unknown) => {
        mocks.upsert(data, options);
        return query;
      },
      single: async () => ({ data: { id: ideaId }, error: null }),
      maybeSingle: async () => ({ data: filtered[0] || null, error: null }),
    };
    return query;
  });
});

describe("cached Discover post handoff", () => {
  it("loads the originating post and separates measured evidence from a creative brief", async () => {
    const context = await loadDiscoverPostContext(workspaceId, {
      recommendationId: ideaId,
      action: "replicate",
    });
    expect(context).toMatchObject({
      recommendationId: ideaId,
      action: "replicate",
      evidence: {
        sourceId: "x:42",
        title: source.title,
        summary: source.summary,
        url: sourceUrl,
        author: "Ada",
        publishedAt: "2026-10-07T10:00:00.000Z",
        retrievedAt: "2026-10-08T10:00:00.000Z",
        metrics: { views: null, likes: 120, comments: 0, saves: null },
        baseline: null,
      },
      inspiration: { title: idea.title, summary: idea.summary, hook: "A suggested hook" },
    });
    expect(mocks.requireContentWorkspace).toHaveBeenCalledWith(workspaceId, "discover");
  });

  it("rejects a recommendation ID belonging to another workspace", async () => {
    await expect(
      loadDiscoverPostContext(otherWorkspace, { recommendationId: ideaId, action: "chat" }),
    ).rejects.toThrow("This Discover item could not be loaded.");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("uses authorized Analytics records and keeps missing values separate from zero", async () => {
    const context = await loadDiscoverPostContext(workspaceId, {
      analyticsPost: analyticsReference,
      action: "variations",
    });
    expect(context.evidence).toMatchObject({
      title: "Our published caption",
      url: sourceUrl,
      retrievedAt: "2026-10-08T10:00:00.000Z",
      metrics: { views: null, likes: 0, comments: 5 },
      baseline: null,
    });
    expect(mocks.requireContentWorkspace).toHaveBeenCalledWith(workspaceId, "socialAnalytics");
    await expect(
      loadDiscoverPostContext(otherWorkspace, {
        analyticsPost: analyticsReference,
        action: "chat",
      }),
    ).rejects.toThrow("This analytics post could not be loaded.");
  });

  it("saves only a workspace-owned observation, with repeat saves targeting the same bookmark", async () => {
    for (let i = 0; i < 2; i++) {
      await expect(saveAnalyticsPostSource(workspaceId, analyticsReference)).resolves.toEqual({
        id: ideaId,
      });
    }
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        user_id: workspaceId,
        fingerprint: `analytics-post:${sourceId}`,
        content_insight_id: sourceId,
        trend_brief_id: null,
        feedback: "saved",
        source_url: sourceUrl,
        source_retrieved_at: "2026-10-08T10:00:00.000Z",
        metadata: {
          saved: true,
          platform: "twitter",
          stats: { likes: 0, comments: 5, views: null, shares: null, saves: null },
        },
      }),
      { onConflict: "user_id,fingerprint" },
    );
    await expect(saveAnalyticsPostSource(otherWorkspace, analyticsReference)).rejects.toThrow(
      "This analytics post could not be loaded.",
    );
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.requireContentWorkspace).toHaveBeenCalledWith(workspaceId, "discover");
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "EXPENSIVE_API_RATE_LIMITER",
      "analytics-research",
      workspaceId,
    );
  });
});
