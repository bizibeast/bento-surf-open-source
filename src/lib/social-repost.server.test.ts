import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  accessTokenForConnection: vi.fn(),
  providerJson: vi.fn(),
}));

vi.mock("./social-publisher.server", () => ({
  accessTokenForConnection: provider.accessTokenForConnection,
  providerJson: provider.providerJson,
  ProviderError: class ProviderError extends Error {
    constructor(
      message: string,
      public code: string,
      public retryable: boolean,
    ) {
      super(message);
    }
  },
  socialPublishQueueBinding: (name: string) =>
    name === "twitter" ? "SOCIAL_PUBLISH_QUEUE_X" : "SOCIAL_PUBLISH_QUEUE_LINKEDIN",
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { createNativeRepost, removeNativeRepost } from "./social-repost.server";

describe("native repost provider requests", () => {
  beforeEach(() => {
    provider.accessTokenForConnection.mockReset().mockResolvedValue("token");
    provider.providerJson.mockReset();
  });

  it("reposts and unreposts the original X post through the retweets API", async () => {
    provider.providerJson
      .mockResolvedValueOnce({ data: { data: { retweeted: true } } })
      .mockResolvedValueOnce({ data: { data: { retweeted: false } } });
    const connection = { provider_user_id: "user-7" };

    expect(await createNativeRepost("twitter", connection, "tweet-9")).toBe("tweet-9");
    await removeNativeRepost("twitter", connection, "tweet-9", "tweet-9");

    expect(provider.providerJson).toHaveBeenNthCalledWith(
      1,
      "https://api.x.com/2/users/user-7/retweets",
      expect.objectContaining({ method: "POST", body: '{"tweet_id":"tweet-9"}' }),
      "twitter",
    );
    expect(provider.providerJson).toHaveBeenNthCalledWith(
      2,
      "https://api.x.com/2/users/user-7/retweets/tweet-9",
      expect.objectContaining({ method: "DELETE" }),
      "twitter",
    );
  });

  it("creates and deletes a LinkedIn reshare without deleting the parent post", async () => {
    provider.providerJson
      .mockResolvedValueOnce({
        data: {},
        response: { headers: new Headers({ "x-restli-id": "urn:li:share:reshare-2" }) },
      })
      .mockResolvedValueOnce({ data: {}, response: { headers: new Headers() } });
    const connection = { provider_user_id: "urn:li:person:member-1" };

    const repostId = await createNativeRepost("linkedin", connection, "urn:li:share:original-1");
    expect(repostId).toBe("urn:li:share:reshare-2");
    await removeNativeRepost("linkedin", connection, "urn:li:share:original-1", repostId);

    const createCall = provider.providerJson.mock.calls[0];
    expect(createCall[0]).toBe("https://api.linkedin.com/rest/posts");
    expect(JSON.parse(createCall[1].body)).toMatchObject({
      author: "urn:li:person:member-1",
      reshareContext: { parent: "urn:li:share:original-1" },
    });
    expect(provider.providerJson.mock.calls[1][0]).toBe(
      "https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3Areshare-2",
    );
    expect(provider.providerJson.mock.calls[1][1].method).toBe("DELETE");
  });
});
