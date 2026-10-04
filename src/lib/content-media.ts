import { z } from "zod";
import { parsePublicHttpUrl } from "./safe-url";

export const contentMediaSourceSchema = z.object({
  id: z.string().trim().min(1).max(500),
  type: z.enum(["image", "video", "thumbnail"]),
  url: z
    .string()
    .max(5000)
    .nullable()
    .optional()
    .refine(
      (value) => !value || Boolean(parsePublicHttpUrl(value, { requireHttps: true })),
      "Use a public HTTPS media URL.",
    ),
});
export type ContentMediaSource = z.infer<typeof contentMediaSourceSchema>;

export const contentMediaAssetSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["image", "video"]),
    url: z
      .string()
      .url()
      .refine((value) => Boolean(parsePublicHttpUrl(value, { requireHttps: true }))),
    title: z.string().max(160),
    caption: z.string().max(2000),
    tags: z.array(z.string().max(80)).max(8),
    provider: z.string().max(30),
    role: z.enum(["attachment", "thumbnail"]).optional(),
    mimeType: z.string().max(100).optional(),
    sourceUrl: z
      .string()
      .url()
      .nullable()
      .refine((value) => !value || Boolean(parsePublicHttpUrl(value, { requireHttps: true }))),
  })
  .strict();
export type ContentMediaAsset = z.infer<typeof contentMediaAssetSchema>;

export function contentMediaSearchTerms(request: string) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "write",
    "post",
    "draft",
    "about",
    "linkedin",
    "twitter",
    "my",
    "in",
    "on",
    "to",
    "of",
    "a",
    "an",
  ]);
  return [
    ...new Set(
      (request.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(
        (term) => term.length > 1 && !stop.has(term),
      ),
    ),
  ].slice(0, 20);
}

export function relevantContentMedia(request: string, assets: ContentMediaAsset[]) {
  const terms = contentMediaSearchTerms(request);
  const scored = assets
    .map((asset) => ({
      asset,
      score: terms.reduce(
        (score, term) =>
          score +
          (asset.tags.some((tag) => tag.toLowerCase().includes(term)) ? 4 : 0) +
          (`${asset.title} ${asset.caption}`.toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter((value) => value.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored
    .filter(
      (value, index) => scored.findIndex((other) => other.asset.url === value.asset.url) === index,
    )
    .slice(0, 8)
    .map((value) => value.asset);
}

export function contentMediaSources(values: unknown): ContentMediaSource[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 20).flatMap((value) => {
    const result = contentMediaSourceSchema.safeParse(value);
    return result.success ? [result.data] : [];
  });
}
