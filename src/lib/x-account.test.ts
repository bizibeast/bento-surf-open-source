import { afterEach, describe, expect, it, vi } from "vitest";
import {
  xAccountCapabilities,
  xArticleContentState,
  xArticleDocumentError,
  xArticlePlainText,
  xArticlePostId,
  xCapabilitiesFromMetadata,
  type XArticleDocument,
} from "./x-account";
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

  it("serializes Article formatting, images, and embedded posts for X", () => {
    const image = {
      key: "user/image.jpg",
      url: "https://bento.surf/image.jpg",
      name: "image.jpg",
      mimeType: "image/jpeg",
      size: 100,
    };
    const article: XArticleDocument = {
      cover: image,
      blocks: [
        { kind: "text", type: "header-two", text: "**Results** and [source](https://example.com)" },
        { kind: "image", media: image },
        { kind: "post", url: "https://x.com/creator/status/123456789" },
      ],
    };
    expect(xArticleDocumentError(article)).toBeNull();
    expect(xArticlePlainText(article)).toBe("**Results** and [source](https://example.com)");
    expect(
      xArticleContentState(xArticlePlainText(article), article, { [image.key]: "987" }),
    ).toEqual({
      blocks: [
        {
          text: "Results and source",
          type: "header-two",
          inline_style_ranges: [{ offset: 0, length: 7, style: "bold" }],
          entity_ranges: [{ key: 0, offset: 12, length: 6 }],
        },
        { text: " ", type: "atomic", entity_ranges: [{ key: 1, offset: 0, length: 1 }] },
        { text: " ", type: "atomic", entity_ranges: [{ key: 2, offset: 0, length: 1 }] },
      ],
      entities: [
        {
          key: "0",
          value: { type: "link", mutability: "mutable", data: { url: "https://example.com" } },
        },
        {
          key: "1",
          value: {
            type: "image",
            mutability: "immutable",
            data: { media_items: [{ media_category: "tweet_image", media_id: "987" }] },
          },
        },
        {
          key: "2",
          value: { type: "post", mutability: "immutable", data: { post_id: "123456789" } },
        },
      ],
    });
    expect(xArticlePostId("https://evil.example/status/123456789")).toBeNull();
    expect(
      xArticleDocumentError({
        ...article,
        blocks: [{ kind: "post", url: "https://evil.example/status/123" }],
      }),
    ).toContain("X post URL");
  });
});
