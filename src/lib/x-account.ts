import { z } from "zod";

export const X_STANDARD_POST_LIMIT = 280;
export const X_LONG_POST_LIMIT = 25_000;

const articleImageSchema = z.object({
  key: z.string().min(1),
  url: z.string().url(),
  name: z.string(),
  mimeType: z.string().refine((value) => ["image/jpeg", "image/png", "image/webp"].includes(value)),
  size: z.number().int().positive(),
});

export const xArticleBlockSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    type: z.enum([
      "unstyled",
      "header-two",
      "header-three",
      "unordered-list-item",
      "ordered-list-item",
      "blockquote",
    ]),
    text: z.string().max(X_LONG_POST_LIMIT),
  }),
  z.object({ kind: z.literal("image"), media: articleImageSchema }),
  z.object({ kind: z.literal("post"), url: z.string().url() }),
]);

export const xArticleDocumentSchema = z.object({
  cover: articleImageSchema.nullable().default(null),
  blocks: z.array(xArticleBlockSchema).max(200),
});

export type XArticleDocument = z.infer<typeof xArticleDocumentSchema>;
export type XArticleBlock = XArticleDocument["blocks"][number];

export function xArticlePostId(input: string): string | null {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com"].includes(
        url.hostname.toLowerCase(),
      )
    )
      return null;
    return (
      url.pathname.match(/^\/(?:i\/web\/)?(?:[^/]+\/)?status\/(\d{1,19})(?:\/|$)/)?.[1] || null
    );
  } catch {
    return null;
  }
}

export function xArticleDocument(value: unknown): XArticleDocument | null {
  const parsed = xArticleDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function xArticleDocumentError(value: unknown): string | null {
  const article = xArticleDocument(value);
  if (!article) return "The X Article content is invalid.";
  if (article.blocks.filter((block) => block.kind === "image").length > 20)
    return "X Articles support up to 20 inline images in Bento.";
  if (article.blocks.some((block) => block.kind === "post" && !xArticlePostId(block.url)))
    return "Use an X post URL for each embedded post.";
  if (
    article.blocks
      .filter((block) => block.kind === "text")
      .reduce((sum, block) => sum + block.text.length, 0) > X_LONG_POST_LIMIT
  )
    return "X Articles allow up to 25,000 characters of text.";
  return null;
}

export function xArticlePlainText(article: XArticleDocument): string {
  return article.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export type XSubscriptionType = "None" | "Basic" | "Premium" | "PremiumPlus";

export type XAccountCapabilities = {
  subscriptionType: XSubscriptionType;
  verifiedType: string | null;
  canPostLong: boolean;
  canPublishArticles: boolean;
};

export function xAccountCapabilities(
  subscriptionType: unknown,
  verifiedType: unknown,
): XAccountCapabilities {
  const tier: XSubscriptionType =
    subscriptionType === "Basic" ||
    subscriptionType === "Premium" ||
    subscriptionType === "PremiumPlus"
      ? subscriptionType
      : "None";
  const verification = typeof verifiedType === "string" ? verifiedType.toLowerCase() : null;
  const organization = verification === "business";
  return {
    subscriptionType: tier,
    verifiedType: verification,
    canPostLong: tier !== "None" || organization,
    canPublishArticles: tier === "Premium" || tier === "PremiumPlus" || organization,
  };
}

export function xCapabilitiesFromMetadata(value: unknown): XAccountCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.x_subscription_type !== "string") return null;
  return xAccountCapabilities(metadata.x_subscription_type, metadata.x_verified_type);
}

export function xCapabilitiesMetadata(capabilities: XAccountCapabilities) {
  return {
    x_subscription_type: capabilities.subscriptionType,
    x_verified_type: capabilities.verifiedType,
    x_capabilities_checked_at: new Date().toISOString(),
  };
}

export function xArticleContentState(
  body: string,
  article?: XArticleDocument | null,
  uploadedMedia: Record<string, string> = {},
) {
  if (!article) {
    return {
      blocks: body.split(/\r?\n/).map((text) => ({ text, type: "unstyled" })),
      entities: [],
    };
  }
  const entities: Array<{
    key: string;
    value: { type: string; mutability: string; data: Record<string, unknown> };
  }> = [];
  const blocks = article.blocks.flatMap<{
    text: string;
    type: string;
    inline_style_ranges?: Array<{ offset: number; length: number; style: string }>;
    entity_ranges?: Array<{ key: number; offset: number; length: number }>;
  }>((block) => {
    if (block.kind === "text") {
      return block.text.split(/\r?\n/).map((line) => {
        // Markdown-like shortcuts give the editor bold, italic, and linked text without storing HTML.
        const ranges: Array<{ offset: number; length: number; style: string }> = [];
        const entityRanges: Array<{ key: number; offset: number; length: number }> = [];
        const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
        let text = "";
        let from = 0;
        for (const match of line.matchAll(pattern)) {
          const offset = match.index ?? 0;
          text += line.slice(from, offset);
          const start = text.length;
          const value = match[1] || match[3] || match[4] || "";
          text += value;
          if (match[1]) {
            const key = entities.length;
            entities.push({
              key: String(key),
              value: { type: "link", mutability: "mutable", data: { url: match[2] } },
            });
            entityRanges.push({ key, offset: start, length: value.length });
          } else {
            ranges.push({
              offset: start,
              length: value.length,
              style: match[3] ? "bold" : "italic",
            });
          }
          from = offset + match[0].length;
        }
        text += line.slice(from);
        return {
          text,
          type: block.type,
          ...(ranges.length ? { inline_style_ranges: ranges } : {}),
          ...(entityRanges.length ? { entity_ranges: entityRanges } : {}),
        };
      });
    }
    const key = entities.length;
    if (block.kind === "post") {
      const postId = xArticlePostId(block.url);
      if (!postId) throw new Error("Invalid embedded X post URL.");
      entities.push({
        key: String(key),
        value: { type: "post", mutability: "immutable", data: { post_id: postId } },
      });
    } else {
      const mediaId = uploadedMedia[block.media.key];
      if (!mediaId) throw new Error("An X Article image has not been uploaded to X.");
      entities.push({
        key: String(key),
        value: {
          type: "image",
          mutability: "immutable",
          data: { media_items: [{ media_category: "tweet_image", media_id: mediaId }] },
        },
      });
    }
    return [{ text: " ", type: "atomic" as const, entity_ranges: [{ key, offset: 0, length: 1 }] }];
  });
  return { blocks, entities };
}
