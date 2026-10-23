import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  entitlement: vi.fn(),
  rate: vi.fn(),
  window: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./plan.server", () => ({ requirePlanEntitlement: mocks.entitlement }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: mocks.rate }));
vi.mock("./mcp-analytics-window.server", () => ({ mcpAnalyticsWindow: mocks.window }));
import { getSchedulerPost, listSchedulerPosts } from "./mcp-scheduler-read.server";
import { decodeSchedulerCursor } from "./mcp-scheduler-read";

const owner = "11111111-1111-4111-8111-111111111111";
const postId = "22222222-2222-4222-8222-222222222222";
function query(data: unknown, error: unknown = null) {
  const q: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "gte", "gt", "lt", "or", "ilike", "in", "limit", "order"])
    q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn(async () => ({ data, error }));
  q.then = vi.fn((resolve) => Promise.resolve({ data, error }).then(resolve));
  return q;
}
const target = {
  id: "target-1",
  connection_id: "connection-1",
  provider: "instagram",
  remote_post_id: "18075238427758902",
  remote_post_url: null,
  status: "published",
  published_at: "2026-10-19T03:32:33Z",
  provider_settings: { bodyOverride: "Platform caption", trialReel: true },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.entitlement.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  mocks.window.mockResolvedValue({
    startTimestamp: "2026-07-01T00:00:00Z",
    historyDays: 90,
    timeZone: "Asia/Kolkata",
  });
});
describe("owned Scheduler reads", () => {
  it("paginates stable timestamps and filters destination publication rather than parent creation", async () => {
    const rows = [
      { id: postId, created_at: "2026-10-18T00:00:00Z", targets: [target] },
      {
        id: "22222222-2222-4222-8222-222222222221",
        created_at: "2026-10-18T00:00:00Z",
        targets: [target],
      },
    ];
    const first = query(rows);
    const second = query([rows[1]]);
    mocks.from.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const filters = {
      provider: "instagram" as const,
      targetStatus: "published" as const,
      dateFrom: "2026-10-18T18:30:00Z",
      dateTo: "2026-10-19T18:30:00Z",
    };
    const result = await listSchedulerPosts(owner, undefined, 1, filters);
    expect(first.select).toHaveBeenCalledWith(expect.stringContaining("social_post_targets!inner"));
    expect(first.eq).toHaveBeenCalledWith("user_id", owner);
    expect(first.eq).toHaveBeenCalledWith("targets.provider", "instagram");
    expect(first.eq).toHaveBeenCalledWith("targets.status", "published");
    expect(first.gte).toHaveBeenCalledWith("targets.published_at", filters.dateFrom);
    expect(first.lt).toHaveBeenCalledWith("targets.published_at", filters.dateTo);
    expect(result.posts).toHaveLength(1);
    expect(result.pagination.hasMore).toBe(true);
    expect(decodeSchedulerCursor(result.pagination.nextCursor!)).toEqual({
      createdAt: rows[0].created_at,
      id: postId,
    });
    const next = await listSchedulerPosts(owner, undefined, 1, {
      ...filters,
      cursor: result.pagination.nextCursor!,
    });
    expect(second.or).toHaveBeenCalledWith(
      `created_at.lt.${rows[0].created_at},and(created_at.eq.${rows[0].created_at},id.lt.${postId})`,
    );
    expect(next.posts[0].id).toBe(rows[1].id);
    expect(next.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });
  it("keeps legacy parent status semantics and rejects forged cursors and inverted dates", async () => {
    const q = query([]);
    mocks.from.mockReturnValue(q);
    await listSchedulerPosts(owner, "draft", 30);
    expect(q.eq).toHaveBeenCalledWith("status", "draft");
    expect(q.eq).not.toHaveBeenCalledWith("targets.status", "draft");
    await expect(
      listSchedulerPosts(owner, undefined, 30, {
        cursor: btoa(JSON.stringify({ createdAt: "x),user_id.neq.foo", id: postId })),
      }),
    ).rejects.toThrow("Invalid Scheduler cursor");
    await expect(
      listSchedulerPosts(owner, undefined, 30, {
        dateFrom: "2026-10-20T00:00:00Z",
        dateTo: "2026-10-19T00:00:00Z",
      }),
    ).rejects.toThrow("dateFrom");
  });
  it("joins metrics only to the exact owned destination and paginates attempts without bearer capabilities", async () => {
    const post = query({
      id: postId,
      created_at: "2026-10-18T00:00:00Z",
      body: "Full caption",
      media: [{ key: "owner/asset.mp4" }],
      targets: [
        {
          ...target,
          upload_session_url: "private",
          provider_settings: { ...target.provider_settings, access_token: "secret" },
        },
      ],
    });
    const metrics = query({
      remote_post_url: "https://www.instagram.com/reel/DeqTCCDDGA5/",
      views: 1251,
      fetched_at: "2026-10-21T02:01:31Z",
    });
    const attempts = query([
      { id: 12, target_id: target.id, outcome: "succeeded" },
      { id: 11, target_id: target.id, outcome: "failed" },
    ]);
    mocks.from.mockReturnValueOnce(post).mockReturnValueOnce(metrics).mockReturnValueOnce(attempts);
    const result = await getSchedulerPost(owner, {
      id: postId,
      attemptsLimit: 1,
      attemptsCursor: "15",
    });
    expect(post.eq).toHaveBeenCalledWith("user_id", owner);
    expect(post.eq).toHaveBeenCalledWith("id", postId);
    for (const pair of [
      ["user_id", owner],
      ["connection_id", target.connection_id],
      ["provider", "instagram"],
      ["remote_post_id", target.remote_post_id],
    ])
      expect(metrics.eq).toHaveBeenCalledWith(...pair);
    expect(metrics.gte).toHaveBeenCalledWith("published_at", "2026-07-01T00:00:00Z");
    expect(result.post.targets[0]).toMatchObject({
      metrics: { views: 1251, fetched_at: "2026-10-21T02:01:31Z" },
      resolvedRemotePostUrl: "https://www.instagram.com/reel/DeqTCCDDGA5/",
      remotePostUrlSource: "owned_stored_insight",
      provider_settings: { bodyOverride: "Platform caption", trialReel: true },
    });
    expect(result.post.media).toEqual([{ key: "owner/asset.mp4" }]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("upload_session_url");
    expect(attempts.in).toHaveBeenCalledWith("target_id", [target.id]);
    expect(attempts.lt).toHaveBeenCalledWith("id", "15");
    expect(result.attemptsPagination).toEqual({ limit: 1, hasMore: true, nextCursor: "12" });
  });
  it("returns unavailable metrics outside the plan window without querying old insights", async () => {
    const post = query({
      id: postId,
      targets: [{ ...target, published_at: "2026-01-01T00:00:00Z" }],
    });
    mocks.from.mockReturnValueOnce(post).mockReturnValueOnce(query([]));
    const result = await getSchedulerPost(owner, { id: postId });
    expect(result.post.targets[0]).toMatchObject({
      metrics: null,
      metricsAvailability: "outside_plan_history_window",
    });
    expect(mocks.from).not.toHaveBeenCalledWith("social_content_insights");
  });
  it("keeps unlimited-plan stored metrics available without an invalid null date filter", async () => {
    mocks.window.mockResolvedValue({ startTimestamp: null, historyDays: null, timeZone: "UTC" });
    const post = query({
      id: postId,
      targets: [{ ...target, published_at: "2020-01-01T00:00:00Z" }],
    });
    const metrics = query({ views: 7, fetched_at: "2026-10-22T00:00:00Z" });
    mocks.from
      .mockReturnValueOnce(post)
      .mockReturnValueOnce(metrics)
      .mockReturnValueOnce(query([]));
    const result = await getSchedulerPost(owner, { id: postId });
    expect(metrics.gte).not.toHaveBeenCalled();
    expect(result.post.targets[0]).toMatchObject({
      metrics: { views: 7 },
      metricsAvailability: "available",
    });
  });
  it("fails closed before related queries for another owner or a denied entitlement", async () => {
    const missing = query(null);
    mocks.from.mockReturnValue(missing);
    await expect(getSchedulerPost(owner, { id: postId })).rejects.toThrow("not found");
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(missing.eq).toHaveBeenCalledWith("user_id", owner);
    mocks.from.mockClear();
    mocks.entitlement.mockRejectedValue(new Error("Plan denied"));
    await expect(getSchedulerPost(owner, { id: postId })).rejects.toThrow("Plan denied");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
