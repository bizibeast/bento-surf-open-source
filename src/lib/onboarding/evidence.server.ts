import { onboardingDb as db } from "./session.server";
import { onboardingProfile, onboardingStandout, type OnboardingEvidence } from "./evidence";
import { parsePublicHttpUrl } from "../safe-url";

/** Read only already imported workspace data. This does not start provider calls. */
export async function loadOnboardingEvidence(workspaceId: string): Promise<OnboardingEvidence> {
  const { data: connections, error } = await db
    .from("social_connections")
    .select("id,provider,provider_handle,provider_display_name,provider_avatar_url,metadata")
    .eq("user_id", workspaceId)
    .eq("status", "active")
    .limit(20);
  if (error) throw new Error("Your connected profiles could not load.");
  const profiles = ((connections || []) as Array<Record<string, unknown>>).map(onboardingProfile);
  const ids = profiles.map((profile) => profile.connectionId);
  if (!ids.length) return { profiles, postCount: 0, standout: null, inspirations: [] };
  const [posts, recommendations] = await Promise.all([
    db
      .from("social_content_insights")
      .select("id,provider,engagements")
      .eq("user_id", workspaceId)
      .in("connection_id", ids)
      .not("caption", "is", null)
      .neq("caption", "")
      .order("published_at", { ascending: false })
      .limit(120),
    db
      .from("creator_content_recommendations")
      .select("title,summary,source_url,source_name")
      .eq("user_id", workspaceId)
      .in("feedback", ["pending", "saved"])
      .gte("source_published_at", new Date(Date.now() - 7 * 86400000).toISOString())
      .order("created_at", { ascending: false })
      .limit(3),
  ]);
  if (posts.error) throw new Error("Your imported posts could not load.");
  const rows = (posts.data || []) as Array<Record<string, unknown>>;
  const best = rows
    .filter((row) => typeof row.engagements === "number" && row.engagements > 0)
    .sort((a, b) => Number(b.engagements) - Number(a.engagements))[0];
  let standout: OnboardingEvidence["standout"] = null;
  if (best) {
    // Read one caption, rather than transferring a workspace's caption history for a preview.
    const { data: post, error: postError } = await db
      .from("social_content_insights")
      .select("id,provider,caption,remote_post_url,thumbnail_url,published_at,engagements,views")
      .eq("user_id", workspaceId)
      .eq("id", best.id)
      .in("connection_id", ids)
      .maybeSingle();
    if (!postError && post) {
      const selected = onboardingStandout([post]);
      if (selected)
        standout = {
          ...selected,
          comparedPosts: rows.filter(
            (row) => row.provider === selected.provider && typeof row.engagements === "number",
          ).length,
        };
    }
  }
  const inspirations = (
    (recommendations.error ? [] : recommendations.data || []) as Array<Record<string, unknown>>
  )
    .filter(
      (row) =>
        typeof row.source_url === "string" &&
        parsePublicHttpUrl(row.source_url, { requireHttps: true }),
    )
    .map((row) => ({
      title: String(row.title).slice(0, 300),
      summary: String(row.summary || "").slice(0, 1000),
      url: String(row.source_url),
      source: String(row.source_name || "Original source").slice(0, 160),
    }));
  return { profiles, postCount: rows.length, standout, inspirations };
}
