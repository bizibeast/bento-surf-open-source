import { z } from "zod";

export type TrackedDiscoverCreator = {
  id: string;
  profileUrl: string;
  platform: string;
  name: string;
  topics: string;
  avatarUrl: string | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  postCount?: number;
};

/** Only public creator/community URLs, never individual posts or arbitrary fetch targets. */
export function normalizeDiscoverCreator(value: string) {
  const url = new URL(value.trim().replace(/^@/, "https://www.instagram.com/"));
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("Use a public HTTPS creator profile URL.");
  const host = url.hostname.replace(/^(www|m)\./, "");
  let path = url.pathname.replace(/\/+$/, "");
  let platform: string;
  if (host === "reddit.com" && /^\/(r|u|user)\/[\w-]{2,30}$/i.test(path)) {
    platform = "Reddit";
    path = path.replace(/^\/u\//i, "/user/").toLowerCase();
  } else if (
    host === "facebook.com" &&
    (/^\/[\w.-]+$/.test(path) || /^\/groups\/[\w.-]+$/.test(path))
  ) {
    platform = "Facebook";
    if (["reel", "watch", "posts", "login", "share", "photo.php"].includes(path.slice(1)))
      throw new Error("Paste a Facebook creator or page URL, not a post.");
    if (path === "/profile.php" && !/^\d+$/.test(url.searchParams.get("id") || ""))
      throw new Error("This Facebook profile URL needs its profile ID.");
  } else if (
    ["instagram.com", "x.com", "twitter.com", "threads.net", "threads.com"].includes(host) &&
    /^\/@?[\w.]{1,50}$/.test(path)
  ) {
    platform =
      host === "instagram.com" ? "Instagram" : host.startsWith("threads") ? "Threads" : "X";
    if (["p", "reel", "reels", "explore", "home", "search"].includes(path.slice(1)))
      throw new Error("Paste a creator profile URL, not a post.");
  } else if (host === "linkedin.com" && /^\/(in|company)\/[\w%-]+$/.test(path)) {
    platform = "LinkedIn";
  } else if (host === "youtube.com" && /^\/(?:@[\w.-]+|channel\/UC[\w-]+)$/.test(path)) {
    platform = "YouTube";
  } else if (host === "tiktok.com" && /^\/@[\w.]+$/.test(path)) {
    platform = "TikTok";
  } else {
    throw new Error(
      "Use a Facebook, Reddit, Instagram, X, Threads, LinkedIn, YouTube or TikTok profile URL.",
    );
  }
  const canonicalHost =
    host === "twitter.com" ? "x.com" : host === "threads.net" ? "threads.com" : host;
  const query =
    platform === "Facebook" && path === "/profile.php" ? `?id=${url.searchParams.get("id")}` : "";
  return {
    profileUrl: `https://www.${canonicalHost}${path}${query}`,
    platform,
    name: path.split("/").pop()!.replace(/^@/, ""),
  };
}

export const trackDiscoverCreatorSchema = z.object({
  profileUrl: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .transform((value, ctx) => {
      try {
        return normalizeDiscoverCreator(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid creator URL.",
        });
        return z.NEVER;
      }
    }),
  name: z.string().trim().max(120).optional(),
  topics: z.string().trim().max(200).default(""),
});

export function creatorMatchesSource(
  creator: Pick<TrackedDiscoverCreator, "profileUrl" | "platform">,
  source: { authorUrl?: string | null; canonicalUrl?: string; sourceUrl?: string | null },
) {
  const clean = (value: string) =>
    value
      .toLowerCase()
      .replace(/^https:\/\/(?:www\.|m\.)?/, "")
      .replace(/\/+$/, "");
  if (source.authorUrl && clean(source.authorUrl) === clean(creator.profileUrl)) return true;
  const post = source.canonicalUrl || source.sourceUrl;
  if (!post) return false;
  const target = clean(creator.profileUrl);
  if (creator.platform === "Facebook") {
    const profileId = new URL(creator.profileUrl).searchParams.get("id");
    if (profileId) {
      const url = new URL(post);
      return (
        /^(www\.|m\.)?facebook\.com$/.test(url.hostname) &&
        (url.searchParams.get("id") === profileId || url.pathname.startsWith(`/${profileId}/`))
      );
    }
  }
  return (
    clean(post).startsWith(`${target}/`) &&
    (creator.platform !== "Reddit" || target.includes("/r/"))
  );
}
