import { onboardingDb as db } from "./session.server";
import { onboardingProfile, type OnboardingProfile } from "./evidence";
import type { OnboardingBrief } from "./brief";

export type OnboardingSource = {
  id?: string;
  connection_id?: string;
  provider: string;
  remote_post_id?: string;
  caption: string | null;
  remote_post_url: string | null;
  published_at?: string | null;
  engagements?: number | null;
  content_type?: string | null;
};
export type OnboardingResearch = {
  profiles: OnboardingProfile[];
  posts: OnboardingSource[];
  photoPostId: string | null;
};
const MAX_POSTS = 24;
const SOURCE_BYTE_LIMIT = 24_000;

function excerpt(value: string, bytes: number) {
  return new TextDecoder()
    .decode(new TextEncoder().encode(value).slice(0, bytes))
    .replace(/\uFFFD$/, "");
}

/** Mix strongest and recent work across connected platforms, rather than taking one account's feed. */
export function onboardingSampleIds(rows: Array<Record<string, unknown>>) {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = String(row.provider);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const queues = [...groups.values()].map((group) => {
    const strongest = [...group].sort(
      (a, b) => Number(b.engagements || 0) - Number(a.engagements || 0),
    );
    return [
      ...new Map(
        group
          .flatMap((row, index) => [strongest[index], row])
          .filter(Boolean)
          .map((row) => [String(row.id), row]),
      ).values(),
    ];
  });
  const ids: string[] = [];
  for (let index = 0; ids.length < MAX_POSTS && index < MAX_POSTS; index++)
    for (const queue of queues)
      if (queue[index] && ids.length < MAX_POSTS) ids.push(String(queue[index].id));
  return ids;
}

/** Bounded reads of cached, owned sources. No provider scraping or AI request occurs here. */
export async function loadOnboardingResearch(workspaceId: string): Promise<OnboardingResearch> {
  const { data: connections, error } = await db
    .from("social_connections")
    .select("id,provider,provider_handle,provider_display_name,provider_avatar_url,metadata")
    .eq("user_id", workspaceId)
    .eq("status", "active")
    .limit(20);
  if (error) throw new Error("Your connected profile evidence could not load.");
  const profiles = ((connections || []) as Array<Record<string, unknown>>).map(onboardingProfile);
  const connectionIds = profiles.map((profile) => profile.connectionId);
  if (!connectionIds.length) return { profiles, posts: [], photoPostId: null };
  const { data: headers, error: headerError } = await db
    .from("social_content_insights")
    .select("id,provider,engagements,published_at")
    .eq("user_id", workspaceId)
    .in("connection_id", connectionIds)
    .not("caption", "is", null)
    .neq("caption", "")
    .order("published_at", { ascending: false })
    .limit(120);
  if (headerError) throw new Error("Your imported source history could not load.");
  const ids = onboardingSampleIds(headers || []);
  if (!ids.length) return { profiles, posts: [], photoPostId: null };
  const { data: details, error: detailError } = await db
    .from("social_content_insights")
    .select(
      "id,connection_id,provider,remote_post_id,caption,remote_post_url,published_at,engagements,content_type",
    )
    .eq("user_id", workspaceId)
    .in("connection_id", connectionIds)
    .in("id", ids)
    .limit(MAX_POSTS);
  if (detailError) throw new Error("Your post samples could not load.");
  const posts = ids.flatMap((id) => {
    const row = (details || []).find((item: OnboardingSource) => item.id === id);
    return row ? [row as OnboardingSource] : [];
  });
  const eligible = posts
    .filter(
      (post) =>
        post.provider === "instagram" &&
        ["image", "carousel"].includes(post.content_type || "") &&
        (post.caption || "").trim().length >= 80,
    )
    .slice(0, 6);
  let photoPostId: string | null = null;
  if (eligible.length) {
    const { data: media, error: mediaError } = await db
      .from("social_content_insights")
      .select("id,media_sources")
      .eq("user_id", workspaceId)
      .in("connection_id", connectionIds)
      .in(
        "id",
        eligible.map((post) => post.id),
      )
      .limit(6);
    if (!mediaError)
      photoPostId =
        eligible.find((post) =>
          (media || []).some(
            (row: { id: string; media_sources: Array<{ type?: string; url?: string }> }) =>
              row.id === post.id &&
              Array.isArray(row.media_sources) &&
              row.media_sources.some((asset) => asset.type === "image" && asset.url),
          ),
        )?.id || null;
  }
  return { profiles, posts, photoPostId };
}

/** A local evidence bundle, with public profile fields and a fixed UTF-8 byte ceiling. */
export function onboardingBrainSources(brief: OnboardingBrief, research: OnboardingResearch) {
  const raw = [
    {
      id: "answers",
      label: "Your onboarding answers",
      type: "answers",
      url: null as string | null,
      text: [
        `Name: ${brief.displayName}`,
        `Expertise: ${brief.expertise}`,
        `Audience: ${brief.audience}`,
        brief.bio && `Bio: ${brief.bio}`,
        brief.offer && `Offer: ${brief.offer}`,
        `Voice preference: ${brief.voice}`,
        brief.writingSample && `Writing sample: ${brief.writingSample}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    ...research.profiles.map((profile) => ({
      id: `profile:${profile.connectionId}`,
      label: `${profile.provider} profile`,
      type: "profile",
      url: profile.profileUrl,
      text: [
        `${profile.name} (@${profile.handle})`,
        profile.headline && `Headline: ${profile.headline}`,
        profile.company && `Company: ${profile.company}`,
        profile.location && `Location: ${profile.location}`,
        profile.biography,
      ]
        .filter(Boolean)
        .join("\n"),
    })),
    ...research.posts.map((post, index) => ({
      id: `post:${index}`,
      label: `${post.provider} post${post.published_at ? ` (${post.published_at.slice(0, 10)})` : ""}`,
      type: "post",
      url: post.remote_post_url,
      text: post.caption || "",
    })),
  ];
  const remaining: Record<string, number> = {
    answers: 4000,
    profile: 6000,
    post: SOURCE_BYTE_LIMIT - 10000,
  };
  return raw.flatMap((source) => {
    const limit =
      source.type === "answers"
        ? 4000
        : source.type === "profile"
          ? Math.floor(6000 / Math.max(1, research.profiles.length))
          : Math.floor(14000 / Math.max(1, research.posts.length));
    const text = excerpt(source.text, Math.min(limit, remaining[source.type]));
    remaining[source.type] -= new TextEncoder().encode(text).byteLength;
    return text ? [{ ...source, text }] : [];
  });
}
