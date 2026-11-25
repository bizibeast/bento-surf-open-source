import { describe, expect, it, vi } from "vitest";
import {
  readOwnedInstagramPost,
  readInstagramBusinessDiscoveryPost,
  readOwnedLinkedInPost,
  type PostStatsConnection,
} from "./post-stats-platform-api";

const instagram = "https://instagram.com/reel/ExactPost";
const connection: PostStatsConnection = {
  id: "connection",
  provider: "instagram",
  provider_user_id: "123",
  provider_handle: "creator",
  scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
  status: "active",
};
const media = {
  id: "456",
  owner: { id: "123" },
  permalink: instagram,
  like_count: 0,
  comments_count: 3,
};
describe("official post counter access", () => {
  it("verifies Instagram Login's app-scoped owner alias through the authorized profile", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/456")) return Response.json({ ...media, owner: { id: "789" } });
      if (url.pathname.endsWith("/me")) return Response.json({ id: "789", user_id: "123" });
      return Response.json({ data: [] });
    });
    const result = await readOwnedInstagramPost(instagram, connection, "credential", "456", {
      fetcher,
    });
    expect(result?.counts).toMatchObject({ likes: 0, comments: 3 });
    expect(
      fetcher.mock.calls.some((call) => new URL(String(call[0])).pathname.endsWith("/me")),
    ).toBe(true);
  });
  it("never accepts an owner alias from a profile whose canonical account differs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...media, owner: { id: "789" } }))
      .mockResolvedValueOnce(Response.json({ id: "789", user_id: "999" }));
    await expect(
      readOwnedInstagramPost(instagram, connection, "credential", "456", { fetcher }),
    ).rejects.toMatchObject({ reason: "identity" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reads exact owned Instagram media, preserves verified zero and omits unsupported insights", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.searchParams.has("access_token")).toBe(false);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer credential");
      expect(init?.redirect).toBe("manual");
      if (url.pathname.endsWith("/456")) return Response.json(media);
      const metric = url.searchParams.get("metric");
      return metric === "saved"
        ? new Response(null, { status: 400 })
        : Response.json({
            data: [{ name: metric, values: [{ value: metric === "views" ? 100 : 8 }] }],
          });
    });
    const result = await readOwnedInstagramPost(instagram, connection, "credential", "456", {
      fetcher,
    });
    expect(result?.counts).toEqual({
      likes: 0,
      comments: 3,
      views: 100,
      reach: 8,
      shares: 8,
      reposts: 8,
    });
    expect(result?.evidence.likes).toMatchObject({
      kind: "platform_api",
      precision: "reported",
      visibility: "workspace",
    });
    expect(JSON.stringify(result)).not.toContain("credential");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it("rejects foreign owners and changed permalinks before requesting insights", async () => {
    for (const change of [
      { owner: { id: "other" } },
      { permalink: "https://instagram.com/reel/Another" },
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ ...media, ...change }));
      await expect(
        readOwnedInstagramPost(instagram, connection, "credential", "456", { fetcher }),
      ).rejects.toMatchObject({ reason: "identity" });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("denies missing analytics permission without contacting Instagram", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      readOwnedInstagramPost(
        instagram,
        { ...connection, scopes: ["instagram_business_basic"] },
        "credential",
        undefined,
        { fetcher },
      ),
    ).rejects.toMatchObject({ reason: "permission" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds media lookup and ignores hostile pagination URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      expect(new URL(String(input)).host).toBe("graph.instagram.com");
      return Response.json({
        data: [],
        paging: { next: "https://127.0.0.1/private", cursors: { after: "next" } },
      });
    });
    expect(
      await readOwnedInstagramPost(instagram, connection, "credential", undefined, { fetcher }),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses Business Discovery for exact professional media and never invents saves/shares", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        business_discovery: {
          username: "creator",
          media: { data: [{ ...media, view_count: 120 }] },
        },
      }),
    );
    const result = await readInstagramBusinessDiscoveryPost(
      instagram,
      "creator",
      "123",
      "credential",
      { fetcher, metaVersion: "v27.0" },
    );
    expect(result?.counts).toEqual({ likes: 0, comments: 3, views: 120 });
    expect(result?.evidence.views?.definition).toContain("paid and organic");
    expect(result?.evidence.views?.visibility).toBe("public");
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("fields")).toContain(
      "view_count",
    );
  });
  it("rejects Business Discovery identity changes and stops after two pages", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ business_discovery: { username: "different", media: { data: [media] } } }),
      );
    await expect(
      readInstagramBusinessDiscoveryPost(instagram, "creator", "123", "credential", { fetcher }),
    ).rejects.toMatchObject({ reason: "identity" });
    fetcher.mockClear().mockImplementation(async () =>
      Response.json({
        business_discovery: {
          username: "creator",
          media: {
            data: [{ ...media, permalink: "https://instagram.com/reel/Wrong" }],
            paging: { cursors: { after: "next" } },
          },
        },
      }),
    );
    expect(
      await readInstagramBusinessDiscoveryPost(instagram, "creator", "123", "credential", {
        fetcher,
      }),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

const linkedin: PostStatsConnection = {
  ...connection,
  provider: "linkedin",
  provider_user_id: "urn:li:person:owner",
  scopes: ["r_member_social", "r_member_postAnalytics"],
};
const linkedUrl = "https://linkedin.com/feed/update/urn:li:share:123";
describe("LinkedIn owner identity and metric semantics", () => {
  it("stops after provider backpressure instead of requesting every remaining metric", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "urn:li:share:123", author: linkedin.provider_user_id }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    const result = await readOwnedLinkedInPost(linkedUrl, linkedin, "credential", undefined, {
      fetcher,
    });
    expect(result?.notes?.[0]).toContain("rate-limited");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never guesses share IDs from an activity URL", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await readOwnedLinkedInPost(
        "https://linkedin.com/feed/update/urn:li:activity:123",
        linkedin,
        "credential",
        undefined,
        { fetcher },
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps video plays, impressions and unique viewers distinct and ignores other entities", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/posts/"))
        return Response.json({
          id: "urn:li:share:123",
          author: linkedin.provider_user_id,
          content: { media: { id: "urn:li:video:456" } },
        });
      const metric = url.searchParams.get("queryType");
      return Response.json({
        elements: [
          { targetEntity: { share: "urn:li:share:wrong" }, metricType: metric, count: 999 },
          {
            targetEntity: { share: "urn:li:share:123" },
            metricType: metric,
            count: metric === "IMPRESSION" ? 300 : metric === "VIDEO_PLAY" ? 100 : 5,
          },
        ],
      });
    });
    const result = await readOwnedLinkedInPost(linkedUrl, linkedin, "credential", undefined, {
      fetcher,
    });
    expect(result?.counts).toMatchObject({
      impressions: 300,
      views: 100,
      unique_viewers: 5,
      watch_time_ms: 5,
      likes: 5,
    });
    expect(result?.evidence.views?.definition).toContain("two seconds");
    expect(result?.evidence.impressions?.definition).toContain("not video plays");
    expect(fetcher).toHaveBeenCalledTimes(12);
  });
  it("does not expose a different author's analytics", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: "urn:li:share:123", author: "urn:li:person:foreign" }),
      );
    await expect(
      readOwnedLinkedInPost(linkedUrl, linkedin, "credential", undefined, { fetcher }),
    ).rejects.toMatchObject({ reason: "identity" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not request video analytics for text posts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).not.toContain("VideoAnalytics");
      return url.pathname.includes("/posts/")
        ? Response.json({
            id: "urn:li:share:123",
            author: linkedin.provider_user_id,
            commentary: "Text",
          })
        : Response.json({ elements: [] });
    });
    expect(
      (await readOwnedLinkedInPost(linkedUrl, linkedin, "credential", undefined, { fetcher }))
        ?.counts.views,
    ).toBeUndefined();
  });
});
