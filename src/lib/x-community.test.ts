import { describe, expect, it } from "vitest";
import { xCommunityId, recentXCommunities, xCommunityError } from "./x-community";
import { socialPostInputSchema, validatePostForProviders } from "./social-scheduler";

describe("X community destinations", () => {
  it.each([
    "1234567890123456789",
    "https://x.com/i/communities/1234567890123456789",
    "https://twitter.com/i/communities/1234567890123456789/?s=20",
    "x.com/i/communities/1234567890123456789",
  ])("reads the exact ID without number precision loss: %s", (value) => {
    expect(xCommunityId(value)).toBe("1234567890123456789");
  });
  it.each([
    "",
    "1e12",
    "12345678901234567890",
    "https://x.com.evil.test/i/communities/123",
    "https://x.com@evil.test/i/communities/123",
    "https://evil.test@x.com/i/communities/123",
    "http://x.com/i/communities/123",
    "https://x.com/user/status/123",
    "https://x.com/i/communities/123/members",
    "javascript:alert(1)",
  ])("rejects invalid destinations: %s", (value) => expect(xCommunityId(value)).toBeNull());

  it("keeps incomplete destinations in drafts but blocks publishing and Articles", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const data = {
      body: "A useful idea",
      scheduledAt: null,
      publishNow: true,
      connectionIds: [id],
      connectionOverrides: { [id]: { xCommunity: { id: "" } } },
    };
    expect(
      socialPostInputSchema.safeParse({ ...data, asDraft: true, publishNow: false }).success,
    ).toBe(true);
    expect(socialPostInputSchema.safeParse(data).success).toBe(false);
    expect(
      socialPostInputSchema.safeParse({
        ...data,
        connectionOverrides: { [id]: { xCommunity: { id: "123" } } },
      }).success,
    ).toBe(true);
    expect(xCommunityError({ xCommunity: { id: "123" }, kind: "article" })).toMatch(/Articles/);
    expect(
      validatePostForProviders("Post", [], ["twitter"], "", {
        twitter: { xCommunity: { id: "bad" } },
      }).twitter,
    ).toMatch(/community link/);
    expect(xCommunityError({ xCommunity: null })).toBeNull();
  });

  it("reuses at most 20 unique choices from the same X account without a provider lookup", () => {
    const target = (connectionId: string, id: string) => ({
      connectionId,
      provider: "twitter",
      providerSettings: { xCommunity: { id, name: "Builders" } },
    });
    const posts = [
      {
        targets: [
          target("other", "999"),
          target("mine", "not a link"),
          target("mine", "123"),
          target("mine", "https://x.com/i/communities/123"),
        ],
      },
      ...Array.from({ length: 25 }, (_, i) => ({ targets: [target("mine", String(200 + i))] })),
    ];
    const choices = recentXCommunities(posts, "mine");
    expect(choices).toHaveLength(20);
    expect(choices[0]).toEqual({ id: "123", name: "Builders" });
    expect(choices.some((item) => item.id === "999")).toBe(false);
  });
});
