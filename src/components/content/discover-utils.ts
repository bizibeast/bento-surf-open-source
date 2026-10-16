import { discoverPostKey } from "@/lib/content-discover-identity";
import { sourceCreator, sourcePostEmbed, sourceThumbnail } from "@/lib/content-source-media";
import type { DiscoverRecommendation } from "@/lib/content-discovery.functions";

export type DiscoverBoostAction = "chat" | "variations" | "reverse-engineer" | "replicate";

export function discoverAgentPrompt(item: DiscoverRecommendation, action: DiscoverBoostAction) {
  const instructions = {
    chat: "Help me explore this idea",
    variations: "Generate fresh angles and original variations inspired by this post, in my voice",
    "reverse-engineer":
      "Reverse engineer why this post works: break down its hook, structure, pacing, and audience appeal. Distinguish evidence from assumptions",
    replicate:
      "Create an original draft with my own perspective and wording. Use only X single text post, LinkedIn text post, or Instagram static carousel. Choose a supported platform from my strategy, or ask me to choose. Treat video/source platforms and any suggested legacy format below as source context only. Use the editorial evidence, novelty and provenance checks; never invent my experience",
  };
  const ideaContext =
    item.kind === "idea"
      ? [
          "This is an original creation brief inspired by the linked source, not a claim about what the source creator wrote. Credit the source, use my own experience, and do not invent performance claims.",
          item.inspiration?.hook && `Suggested opening hook: ${item.inspiration.hook}`,
          item.inspiration?.format &&
            `Source idea format (adapt to a supported output): ${item.inspiration.format}`,
          item.inspiration?.outline.length &&
            `Outline:\n${item.inspiration.outline.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
          item.angles.length &&
            `Angles to explore:\n${item.angles.map((angle) => `- ${angle}`).join("\n")}`,
          item.inspiration?.whyNow && `Why now: ${item.inspiration.whyNow}`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : "";
  return `${instructions[action]}: ${item.title}\n${item.sourceUrl || ""}\n${item.summary || ""}\n${ideaContext}`.trim();
}

export function platformName(item: DiscoverRecommendation) {
  return item.platform || item.sourceName || "Web";
}

export function creatorName(item: DiscoverRecommendation) {
  return (
    item.author || sourceCreator(item.sourceUrl)?.name || item.sourceName || platformName(item)
  );
}

export function creatorKey(item: DiscoverRecommendation) {
  const identity =
    item.authorUrl ||
    sourceCreator(item.sourceUrl)?.url ||
    item.author?.toLowerCase() ||
    item.sourceUrl ||
    item.id;
  return `${platformName(item).toLowerCase()}:${identity}`;
}

export function formatStat(value: number, percentage = false) {
  if (percentage) return `${Math.round(value * 100)}%`;
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function visibleStats(item: DiscoverRecommendation) {
  const stats = item.stats || {};
  return (
    [
      ["Views", stats.views],
      ["Likes", stats.likes],
      ["Comments", stats.comments],
      ["Shares", stats.shares],
      ["Saves", stats.saves],
      ["Engagement rate", stats.engagementRate],
    ] as const
  ).filter(
    (entry): entry is [(typeof entry)[0], number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
}

export function relativePublishedAt(value: string | null, now: Date) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const hours = Math.max(0, Math.floor((now.getTime() - Date.parse(value)) / 3_600_000));
  if (hours < 1) return "Now";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function recommendationMatches(item: DiscoverRecommendation, query: string) {
  return `${platformName(item)} ${item.author || ""} ${item.title} ${item.summary || ""} ${item.reason} ${item.angles.join(" ")}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}

// Only embed recognized public video URLs; never put arbitrary source URLs in an iframe.
export function youtubeEmbedUrl(sourceUrl: string | null) {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^www\./, "");
    const id =
      host === "youtu.be"
        ? url.pathname.split("/")[1]
        : ["youtube.com", "m.youtube.com"].includes(host)
          ? url.pathname === "/watch"
            ? url.searchParams.get("v")
            : /^\/(shorts|embed)\//.test(url.pathname)
              ? url.pathname.split("/")[2]
              : null
          : null;
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  } catch {
    return null;
  }
}

export function discoverMediaLabel(item: DiscoverRecommendation) {
  if (item.kind === "idea") return "Draft idea";
  const embed = sourcePostEmbed(item.sourceUrl);
  if (embed?.label === "Reel") return "Reel";
  if (item.mediaType === "carousel" || (item.media?.length || 0) > 1) return "Carousel";
  if (item.mediaType === "video" || embed?.label === "Video") return "Video";
  return item.mediaType === "article" ? "Article" : sourceThumbnail(item) ? "Photo" : "Post";
}

export function discoverPostText(item: DiscoverRecommendation) {
  return item.summary.trim().startsWith(item.title.trim())
    ? item.summary
    : [item.title, item.summary].filter(Boolean).join("\n\n");
}

export function relatedDiscoverPosts(
  item: DiscoverRecommendation,
  items: DiscoverRecommendation[],
) {
  const words = (post: DiscoverRecommendation) =>
    new Set(`${post.title} ${post.summary}`.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []);
  const terms = words(item);
  const seen = new Set([discoverPostKey(item)]);
  return items
    .filter((candidate) => candidate.id !== item.id && candidate.feedback !== "not_relevant")
    .sort((a, b) => Number(a.kind === "idea") - Number(b.kind === "idea"))
    .filter((candidate) => {
      const key = discoverPostKey(candidate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((post) => ({
      post,
      score:
        (item.author && post.author && creatorKey(post) === creatorKey(item) ? 8 : 0) +
        [...words(post)].filter((word) => terms.has(word)).length +
        (platformName(post) === platformName(item) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ post }) => post);
}
