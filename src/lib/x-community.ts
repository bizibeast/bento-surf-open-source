import { z } from "zod";

// Incomplete links may be saved in drafts. Publishing validates the destination
// again before any upload or paid request, and never falls back to Everyone.
export const xCommunityDraftSchema = z
  .object({
    id: z.string().max(300),
    name: z.string().trim().max(80).optional(),
  })
  .strict();

export type XCommunity = z.infer<typeof xCommunityDraftSchema>;

export function xCommunityId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (/^[0-9]{1,19}$/.test(input)) return input;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (
      url.protocol !== "https:" ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return url.pathname.match(/^\/i\/communities\/([0-9]{1,19})\/?$/)?.[1] || null;
  } catch {
    return null;
  }
}

export function xCommunityFromSettings(settings: Record<string, unknown>): XCommunity | null {
  const result = xCommunityDraftSchema.safeParse(settings.xCommunity);
  return result.success ? result.data : null;
}

export function xCommunityError(settings: Record<string, unknown>): string | null {
  if (settings.xCommunity == null) return null;
  const community = xCommunityFromSettings(settings);
  if (!community || !xCommunityId(community.id))
    return "Add a valid X community link or ID, or choose Everyone.";
  if (settings.kind === "article") return "Community destinations support X posts, not Articles.";
  return null;
}

export function recentXCommunities(
  posts: Array<{
    targets: Array<{
      connectionId: string;
      provider: string;
      providerSettings?: Record<string, unknown>;
    }>;
  }>,
  connectionId: string,
): XCommunity[] {
  const found = new Map<string, XCommunity>();
  for (const post of posts) {
    for (const target of post.targets) {
      if (target.provider !== "twitter" || target.connectionId !== connectionId) continue;
      const community = xCommunityFromSettings(target.providerSettings || {});
      const id = xCommunityId(community?.id);
      if (community && id && !found.has(id)) found.set(id, { ...community, id });
      if (found.size === 20) return [...found.values()];
    }
  }
  return [...found.values()];
}
