import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({ progress: null as unknown, fail: false }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from() {
      let update: Record<string, unknown> = {};
      const query = {
        update(value: Record<string, unknown>) {
          update = value;
          return query;
        },
        eq() {
          return query;
        },
        select() {
          return query;
        },
        async maybeSingle() {
          if (database.fail) return { error: new Error("DB down"), data: null };
          database.progress = structuredClone(update.publish_progress);
          return { data: { id: "target" }, error: null };
        },
      };
      return query;
    },
  },
}));
import { publishX, publishLinkedIn } from "./social-publisher.server";
import { reserveProviderUsage, ProviderBudgetError } from "./provider-budget.server";
const target = () => ({
  id: "target",
  idempotency_key: "key",
  publish_progress: database.progress,
  connection: { scopes: ["w_member_social_feed"] },
});
beforeEach(() => {
  database.progress = null;
  database.fail = false;
  vi.mocked(reserveProviderUsage).mockReset().mockResolvedValue(undefined);
  let id = 100;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: { id: String(id++) } }, { status: 201 })),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("follow-up provider requests", () => {
  it("chains X replies and charges each write without Premium reads", async () => {
    const result = await publishX(
      "token",
      "First",
      [],
      "",
      { threadReplies: ["Second", "Third"] },
      target(),
    );
    expect(result.id).toBe("100");
    const bodies = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies).toEqual([
      { text: "First" },
      { text: "Second", reply: { in_reply_to_tweet_id: "100" } },
      { text: "Third", reply: { in_reply_to_tweet_id: "101" } },
    ]);
    expect(reserveProviderUsage).toHaveBeenCalledTimes(3);
  });
  it("does not resend the first post when a reply hits the budget limit", async () => {
    vi.mocked(reserveProviderUsage)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ProviderBudgetError("x_write_actions"));
    const settings = { threadReplies: ["Second"] };
    await expect(publishX("token", "First", [], "", settings, target())).rejects.toMatchObject({
      code: "budget_exhausted",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(reserveProviderUsage).mockResolvedValue(undefined);
    const result = await publishX("token", "First", [], "", settings, target());
    expect(result.id).toBe("100");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({
      text: "Second",
      reply: { in_reply_to_tweet_id: "100" },
    });
  });
  it("posts a LinkedIn comment as the original author after confirmation", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:123" } }),
      )
      .mockResolvedValueOnce(Response.json({ id: "comment-id" }, { status: 201 }));
    const result = await publishLinkedIn(
      "urn:li:person:owner",
      "token",
      "Post",
      [],
      { firstComment: "Details" },
      target(),
    );
    expect(result.id).toBe("urn:li:share:123");
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A123/comments",
      expect.objectContaining({
        body: JSON.stringify({
          actor: "urn:li:person:owner",
          object: "urn:li:share:123",
          message: { text: "Details" },
        }),
      }),
    );
  });
  it("rejects missing LinkedIn comment access before publishing the original", async () => {
    await expect(
      publishLinkedIn(
        "owner",
        "token",
        "Post",
        [],
        { firstComment: "Details" },
        { ...target(), connection: { scopes: ["w_member_social"] } },
      ),
    ).rejects.toMatchObject({ code: "comment_scope_required" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains the original when LinkedIn rejects a comment, and resumes only the comment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:123" } }),
      )
      .mockResolvedValueOnce(Response.json({ message: "Too many requests" }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ id: "comment" }, { status: 201 }));
    await expect(
      publishLinkedIn("owner", "token", "Post", [], { firstComment: "Details" }, target()),
    ).rejects.toMatchObject({ status: 429 });
    const result = await publishLinkedIn(
      "owner",
      "token",
      "Post",
      [],
      { firstComment: "Details" },
      target(),
    );
    expect(result.id).toBe("urn:li:share:123");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(fetch).mock.calls[2][0])).toContain("/comments");
  });
  it("makes no request when the checkpoint cannot be stored", async () => {
    database.fail = true;
    await expect(
      publishX("token", "First", [], "", { threadReplies: ["Second"] }, target()),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
