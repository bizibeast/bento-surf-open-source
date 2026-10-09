import { afterEach, describe, expect, it, vi } from "vitest";
import { xAccountCapabilities, xArticleContentState, xCapabilitiesFromMetadata } from "./x-account";
import { fetchXAccountCapabilities } from "./x-account.server";

describe("X account posting privileges", () => {
  afterEach(() => vi.restoreAllMocks());

  it("allows long posts for Basic and Articles for Premium or organizations", () => {
    expect(xAccountCapabilities("None", "blue").canPostLong).toBe(false);
    expect(xAccountCapabilities("Basic", null)).toMatchObject({
      canPostLong: true,
      canPublishArticles: false,
    });
    expect(xAccountCapabilities("Premium", "blue").canPublishArticles).toBe(true);
    expect(xAccountCapabilities("PremiumPlus", null).canPublishArticles).toBe(true);
    expect(xAccountCapabilities("None", "business").canPublishArticles).toBe(true);
    expect(xAccountCapabilities("None", "government").canPublishArticles).toBe(false);
  });

  it("treats missing connection metadata as unknown privileges", () => {
    expect(xCapabilitiesFromMetadata(null)).toBeNull();
    expect(xCapabilitiesFromMetadata({ verified: true })).toBeNull();
    expect(xCapabilitiesFromMetadata({ x_subscription_type: "Basic" })?.canPostLong).toBe(true);
  });

  it("checks the authenticated account's subscription field", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ data: { subscription_type: "Basic", verified_type: "none" } }),
        {
          status: 200,
        },
      ),
    );
    expect(await fetchXAccountCapabilities("user-token")).toMatchObject({
      subscriptionType: "Basic",
      canPostLong: true,
      canPublishArticles: false,
    });
    expect(fetcher.mock.calls[0][0]).toContain("/2/users/me?user.fields=subscription_type");
  });

  it("turns Article paragraphs into DraftJS blocks", () => {
    expect(xArticleContentState("First paragraph\n\nSecond paragraph")).toEqual({
      blocks: [
        { text: "First paragraph", type: "unstyled" },
        { text: "", type: "unstyled" },
        { text: "Second paragraph", type: "unstyled" },
      ],
      entities: [],
    });
  });
});
