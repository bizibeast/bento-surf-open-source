/* eslint-disable @typescript-eslint/no-explicit-any -- Follows table is normalized at this boundary. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { creatorMatchesSource, type TrackedDiscoverCreator } from "./content-discover-creators";
import { fetchRedditStories, type ContentSourceItem } from "./content-sources.server";
import { fetchSocialSearch } from "./content-social-search.server";
import { enrichContentSources } from "./content-source-enrichment.server";
import { sourcePublishedWithin } from "./content-source-recency";
import { discoverPostKey } from "./content-discover-identity";

export async function readDiscoverFollows(userId: string): Promise<TrackedDiscoverCreator[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_discover_follows")
    .select("*")
    .eq("user_id", userId)
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Your tracked creators could not be loaded.");
  return (data || []).map((row: any) => ({
    id: row.id,
    profileUrl: row.profile_url,
    platform: row.platform,
    name: row.name,
    topics: row.topics,
    avatarUrl: row.avatar_url,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
    postCount: row.post_count,
  }));
}

export async function fetchTrackedCreatorPosts(
  creator: TrackedDiscoverCreator,
  locale: { language: string; region: string },
  dependencies = {
    search: fetchSocialSearch,
    reddit: fetchRedditStories,
    enrich: enrichContentSources,
  },
  options: { signal?: AbortSignal; timeoutMs?: number; now?: Date } = {},
): Promise<ContentSourceItem[]> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 12_000, 28_000))),
    ...(options.signal ? [options.signal] : []),
  ]);
  const now = options.now || new Date();
  const recent = (post: ContentSourceItem) =>
    !post.publishedAt || sourcePublishedWithin(post.publishedAt, now.getTime(), 30);
  if (creator.platform === "Reddit") {
    try {
      const posts = await dependencies.reddit("", {
        profileUrl: creator.profileUrl,
        limit: 20,
        windowDays: 30,
        now,
        signal,
      });
      const matching = posts.filter((post) => recent(post) && creatorMatchesSource(creator, post));
      if (matching.length) return matching;
    } catch {
      /* The public JSON API blocks some datacenters; try indexed public posts. */
    }
  }
  signal.throwIfAborted();
  const url = new URL(creator.profileUrl);
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname.replace(/\/$/, "");
  const handle = path.split("/").pop() || creator.name;
  const facebookId = creator.platform === "Facebook" ? url.searchParams.get("id") : null;
  const group = facebookId
    ? `site:facebook.com/${facebookId}/posts/ OR site:facebook.com/permalink.php OR site:facebook.com/story.php`
    : creator.platform === "Instagram"
      ? `site:instagram.com/p/ OR site:instagram.com/reel/`
      : creator.platform === "YouTube"
        ? "site:youtube.com/watch"
        : creator.platform === "LinkedIn"
          ? "site:linkedin.com/posts/ OR site:linkedin.com/feed/update/"
          : creator.platform === "Reddit"
            ? path.startsWith("/user/")
              ? "site:reddit.com/r/"
              : `site:reddit.com${path}/comments/`
            : creator.platform === "Facebook"
              ? `site:${host}${path}/posts/ OR site:${host}${path}/videos/`
              : `site:${host}${path}/`;
  const needsAttribution =
    ["Instagram", "YouTube", "LinkedIn"].includes(creator.platform) || path.startsWith("/user/");
  const found = await dependencies.search(
    {
      ...locale,
      group,
      windowDays: 30,
      limit: 20,
      query: facebookId
        ? `"${facebookId}"`
        : needsAttribution
          ? `"${handle.replace(/["()]/g, "")}"`
          : "",
    },
    { signal },
  );
  const enriched = await dependencies.enrich(found.filter(recent), { timeoutMs: 8_000, signal });
  // Search results are candidates, not proof of authorship. Never put another creator's post in this feed.
  return enriched.filter((post) => recent(post) && creatorMatchesSource(creator, post));
}

type FollowResearchStatus = {
  last_error: string | null;
  last_checked_at: string;
  post_count?: number;
};

async function saveResearchStatus(
  userId: string,
  creatorId: string,
  status: FollowResearchStatus,
  signal: AbortSignal,
) {
  const { error } = await (supabaseAdmin as any)
    .from("creator_discover_follows")
    .update(status)
    .eq("user_id", userId)
    .eq("id", creatorId)
    .abortSignal(signal);
  if (error) throw new Error("The creator's research status could not be saved.");
}

export async function researchDiscoverFollows(
  userId: string,
  creators: TrackedDiscoverCreator[],
  locale: { language: string; region: string },
  options: { signal?: AbortSignal; timeoutMs?: number; now?: Date } = {},
  dependencies = { fetchPosts: fetchTrackedCreatorPosts, saveStatus: saveResearchStatus },
) {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 28_000, 28_000))),
    ...(options.signal ? [options.signal] : []),
  ]);
  // Rotate large follow lists across refreshes; never mark an unattempted creator as checked.
  const checkedAt = (creator: TrackedDiscoverCreator) => {
    const date = Date.parse(creator.lastCheckedAt || "");
    return Number.isFinite(date) ? date : 0;
  };
  const pending = [...creators].sort((a, b) => checkedAt(a) - checkedAt(b)).slice(0, 12);
  const items: ContentSourceItem[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (next < pending.length && !deadline.aborted) {
        const creator = pending[next++];
        let posts: ContentSourceItem[] = [];
        let error: string | null = null;
        let checked = false;
        try {
          posts = await dependencies.fetchPosts(creator, locale, undefined, {
            signal: deadline,
            now: options.now,
          });
          checked = true;
          if (!posts.length)
            error = "No recent public posts found yet. We will check again on your next refresh.";
        } catch (cause) {
          error =
            deadline.aborted ||
            (cause instanceof DOMException && ["TimeoutError", "AbortError"].includes(cause.name))
              ? "This check timed out. It will retry on the next refresh."
              : cause instanceof Error
                ? cause.message
                : "Could not check this creator. Try refreshing.";
        }
        items.push(...posts);
        try {
          await dependencies.saveStatus(
            userId,
            creator.id,
            {
              last_error: error,
              last_checked_at: (options.now || new Date()).toISOString(),
              ...(checked ? { post_count: posts.length } : {}),
            },
            deadline,
          );
        } catch {
          /* A status-write failure must not discard successfully fetched inspiration. */
        }
      }
    }),
  );
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = discoverPostKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
