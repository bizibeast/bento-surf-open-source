import { describe, expect, it, vi } from "vitest";
import { publicPostCountEvidence } from "./content-source-enrichment";
import { platformPostMetrics } from "./public-post-stats";
import { readPublicPostStats } from "./public-post-stats.server";

const json = (value: unknown) =>
  `<script type="application/json">${JSON.stringify(value)}</script>`;
const threads = "https://threads.com/@creator/post/ExactPost";
const threadPage = (shortcode: string, canonical = threads) =>
  `<link rel="canonical" href="${canonical}">` +
  json({
    require: [
      [
        "ScheduledServerJS",
        "handle",
        null,
        [
          {
            __bbox: {
              define: [["BarcelonaLoggedOutExpansionGating", [], { view_counts: 45360 }, 7623]],
              require: [
                [
                  "Router",
                  "init",
                  null,
                  [
                    {
                      initialRouteInfo: { route: { params: { shortcode } } },
                    },
                  ],
                ],
              ],
            },
          },
        ],
      ],
    ],
  });

describe("public post counter parity", () => {
  it("resumes an existing complete public result before repeating failed free extractors", async () => {
    const managed = vi.fn().mockResolvedValue({
      status: "available",
      counts: { score: 17, comments: 3 },
      observedAt: "2026-11-24T12:00:00Z",
    });
    const fetcher = vi.fn<typeof fetch>();
    const result = await readPublicPostStats("https://reddit.com/r/test/comments/abc123/title", {
      cache: null,
      env: {
        POST_STATS_MANAGED_ENABLED: "true",
        BRIGHT_DATA_API_KEY: "credential",
        COBALT_API_URL: "https://media.test.bento.surf",
        COBALT_API_KEY: "service",
      },
      managed,
      fetcher,
    });
    expect(result.status).toBe("available");
    expect(fetcher).not.toHaveBeenCalled();
    expect(managed).toHaveBeenCalledOnce();
    expect(managed.mock.calls[0][2]).toMatchObject({ onlyExisting: true });
  });
  it("merges a managed public supplement without overwriting free-source observations", async () => {
    const managed = vi.fn().mockResolvedValue({
      status: "available",
      counts: { likes: 999, shares: 4 },
      observedAt: "2026-11-24T12:00:00Z",
    });
    const result = await readPublicPostStats("https://facebook.com/reel/12345", {
      cache: null,
      env: { POST_STATS_MANAGED_ENABLED: "true", BRIGHT_DATA_API_KEY: "credential" },
      managed,
      trustedMcpWorkspaceId: "workspace-a",
      reserve: vi.fn().mockResolvedValue(undefined),
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(json({ id: "12345", like_count: 12 }), {
          headers: { "content-type": "text/html" },
        }),
      ),
    });
    expect(result.metrics.find((m) => m.key === "likes")?.value).toBe(12);
    expect(result.metrics.find((m) => m.key === "shares")).toMatchObject({
      value: 4,
      evidence: { kind: "managed_public", visibility: "public" },
    });
    expect(managed.mock.calls[0][2]).toMatchObject({ workspaceId: "workspace-a" });
    expect(managed.mock.calls[0][2]).not.toHaveProperty("reserve");
  });

  it("includes Instagram reposts and keeps Threads shares separate from reposts", () => {
    expect(platformPostMetrics.Instagram).toContain("reposts");
    expect(platformPostMetrics.Threads).toContain("shares");
    expect(
      publicPostCountEvidence(
        json([
          { code: "Other", repost_count: 999 },
          { code: "ExactPost", repost_count: 5, reshare_count: 73 },
        ]),
        "https://instagram.com/reel/ExactPost",
      ),
    ).toEqual({ reposts: 5, shares: 73 });
    expect(
      publicPostCountEvidence(
        json({
          code: "ExactPost",
          share_count: 4,
          text_post_app_info: { repost_count: 7, quote_count: 2, direct_reply_count: 74 },
        }),
        threads,
      ),
    ).toEqual({ shares: 4, reposts: 7, quotes: 2, comments: 74 });
  });

  it("reads the Threads permalink view total only with matching canonical and route identities", () => {
    expect(publicPostCountEvidence(threadPage("ExactPost"), threads)).toEqual({ views: 45360 });
    expect(publicPostCountEvidence(threadPage("OtherPost"), threads)).toEqual({});
    expect(
      publicPostCountEvidence(
        threadPage("ExactPost", threads.replace("ExactPost", "Other")),
        threads,
      ),
    ).toEqual({});
    expect(
      publicPostCountEvidence(
        threadPage("ExactPost").replace('rel="canonical"', 'rel="other"'),
        threads,
      ),
    ).toEqual({});
  });

  it.each([
    [
      "Reddit",
      "https://reddit.com/r/test/comments/abc123/title",
      '<shreddit-post id="t3_abc123" score="17" comment-count="3">',
      "score",
      17,
    ],
    [
      "Facebook",
      "https://facebook.com/reel/12345",
      json({ id: "12345", like_count: 12, comment_count: 3, share_count: 4 }),
      "shares",
      4,
    ],
    ["Threads", threads, threadPage("ExactPost"), "views", 45360],
  ])(
    "uses one budgeted rendered supplement for missing %s public counters",
    async (_platform, url, body, key, value) => {
      const rendered = vi.fn().mockResolvedValue({ value: body });
      const result = await readPublicPostStats(String(url), {
        cache: null,
        env: {},
        rendered,
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("<title>Login</title>", { headers: { "content-type": "text/html" } }),
          ),
      });
      expect(result.metrics.find((metric) => metric.key === key)).toMatchObject({
        value,
        availability: "observed",
        evidence: { kind: "rendered_page", visibility: "public" },
      });
      expect(rendered).toHaveBeenCalledOnce();
    },
  );
});
