import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { accessTokenForConnection } from "./social-publisher.server";
import { reserveProviderUsage, withProviderBudgetWorkspace } from "./provider-budget.server";
import { RequestHttpError } from "./request-security.server";
import { readPublicPostStats } from "./public-post-stats.server";
import {
  normalizePublicPostUrl,
  platformPostMetrics,
  publicPostMetricLabels,
  type PublicPostStats,
} from "./public-post-stats";
import { discoverPostKey } from "./content-discover-identity";
import {
  readOwnedInstagramPost,
  readOwnedLinkedInPost,
  readInstagramBusinessDiscoveryPost,
  facebookInstagramBusinessAccount,
  PlatformStatsAccessError,
  type PlatformPostStats,
  type PostStatsConnection,
} from "./post-stats-platform-api";

const db: SupabaseClient = supabaseAdmin;
type Connection = PostStatsConnection & {
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  user_id: string;
  metadata: unknown;
};
export async function loadPostStatsConnections(workspaceId: string): Promise<Connection[]> {
  const { data, error } = await db
    .from("social_connections")
    .select(
      "id,user_id,provider,provider_user_id,provider_handle,scopes,status,access_token,refresh_token,token_expires_at,metadata",
    )
    .eq("user_id", workspaceId)
    .in("provider", ["instagram", "linkedin", "facebook"])
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(12);
  if (error) throw new RequestHttpError(503, "Connected accounts could not be loaded.");
  return (data || []).filter((row: Connection) => row.user_id === workspaceId);
}
function permalinkVariants(url: string) {
  const source = normalizePublicPostUrl(url)!;
  const variants = new Set([source.url, source.url + "/"]);
  if (source.platform === "Instagram") {
    const code = new URL(source.url).pathname.split("/")[2];
    for (const kind of ["p", "reel", "reels"])
      for (const slash of ["", "/"]) variants.add(`https://instagram.com/${kind}/${code}${slash}`);
  }
  return [...variants].flatMap((value) => [value, value.replace("https://", "https://www.")]);
}
async function indexedId(workspaceId: string, connectionId: string, url: string) {
  const { data, error } = await db
    .from("social_content_insights")
    .select("user_id,connection_id,remote_post_id,remote_post_url")
    .eq("user_id", workspaceId)
    .eq("connection_id", connectionId)
    .in("remote_post_url", permalinkVariants(url))
    .limit(4);
  if (error) return undefined;
  const row = data?.find(
    (row) =>
      row.user_id === workspaceId &&
      row.connection_id === connectionId &&
      typeof row.remote_post_url === "string" &&
      discoverPostKey({ sourceUrl: row.remote_post_url }) === discoverPostKey({ sourceUrl: url }),
  );
  return typeof row?.remote_post_id === "string" ? row.remote_post_id : undefined;
}
export function mergePlatformPostStats(
  base: PublicPostStats,
  additions: PlatformPostStats[],
  notes: string[],
): PublicPostStats {
  const metrics = new Map(base.metrics.map((metric) => [metric.key, { ...metric }]));
  for (const addition of additions)
    for (const [key, value] of Object.entries(addition.counts)) {
      const metricKey = key as keyof typeof publicPostMetricLabels;
      const evidence = addition.evidence[metricKey];
      if (!evidence || !Number.isSafeInteger(value) || value! < 0) continue;
      metrics.set(metricKey, {
        key: metricKey,
        label:
          base.platform === "LinkedIn" && metricKey === "likes"
            ? "Reactions"
            : publicPostMetricLabels[metricKey],
        value: value!,
        availability: "observed",
        evidence,
      });
    }
  const values = [...metrics.values()];
  const observed = values.filter((metric) => metric.value !== null).length;
  return {
    ...base,
    scope: "workspace",
    cached: false,
    metrics: values,
    retrievedAt: new Date().toISOString(),
    status: values.every((metric) => metric.value !== null)
      ? "available"
      : observed
        ? "partial"
        : "unavailable",
    accessNotes: [
      ...new Set([
        ...(base.accessNotes || []),
        ...notes,
        ...additions.flatMap((addition) => addition.notes || []),
      ]),
    ],
    note: "Connected-account analytics are private to this workspace. Each counter identifies its source, observation time and definition. Public counters may be rounded; missing values are not zero.",
  };
}
type Dependencies = {
  connections?: typeof loadPostStatsConnections;
  token?: typeof accessTokenForConnection;
  index?: typeof indexedId;
  publicRead?: typeof readPublicPostStats;
  instagram?: typeof readOwnedInstagramPost;
  linkedin?: typeof readOwnedLinkedInPost;
  discovery?: typeof readInstagramBusinessDiscoveryPost;
  reserve?: typeof reserveProviderUsage;
};
/** workspaceId must come from auth middleware or resolveMcpWorkspaceId, never raw input. */
export async function readWorkspacePostStats(
  input: string,
  workspaceId: string,
  deps: Dependencies = {},
) {
  const source = normalizePublicPostUrl(input);
  if (!source) throw new RequestHttpError(400, "Enter a supported post link.");
  return withProviderBudgetWorkspace(workspaceId, async () => {
    await (deps.reserve ?? reserveProviderUsage)("mcp_media_resolutions", 1, { workspaceId });
    const connections = await (deps.connections ?? loadPostStatsConnections)(workspaceId);
    // Defense in depth even when a dependency supplies rows from another tenant.
    const eligible = connections.filter(
      (row) => row.user_id === workspaceId && row.status === "active",
    );
    const notes: string[] = [];
    const additions: PlatformPostStats[] = [];
    const platform = source.platform.toLowerCase();
    const owned = eligible.filter((row) => row.provider === platform).slice(0, 2);
    const signal = AbortSignal.timeout(35_000);
    if (["Instagram", "LinkedIn"].includes(source.platform)) {
      if (!owned.length)
        notes.push(
          `Connect an ${source.platform === "Instagram" ? "Instagram professional" : "approved LinkedIn analytics"} account to read its owner analytics.`,
        );
      for (const connection of owned) {
        const ready =
          connection.provider === "instagram"
            ? connection.scopes.includes("instagram_business_manage_insights") ||
              connection.scopes.includes("instagram_manage_insights")
            : connection.scopes.includes("r_member_postAnalytics") &&
              connection.scopes.includes("r_member_social");
        if (!ready) {
          notes.push(
            `${source.platform} analytics permission is missing. App approval and reconnecting the account may be required.`,
          );
          continue;
        }
        try {
          const token = await (deps.token ?? accessTokenForConnection)(connection);
          const id = await (deps.index ?? indexedId)(workspaceId, connection.id, source.url);
          const options = {
            signal,
            metaVersion: process.env.META_GRAPH_API_VERSION,
            linkedInVersion: process.env.LINKEDIN_API_VERSION,
          };
          const result =
            connection.provider === "instagram"
              ? await (deps.instagram ?? readOwnedInstagramPost)(
                  source.url,
                  connection,
                  token,
                  id,
                  options,
                )
              : await (deps.linkedin ?? readOwnedLinkedInPost)(
                  source.url,
                  connection,
                  token,
                  id,
                  options,
                );
          if (result && Object.keys(result.counts).length) {
            additions.push(result);
            break;
          }
          notes.push(
            source.platform === "LinkedIn"
              ? "The exact LinkedIn post was not resolved to this account. Activity links may need an Insights sync before owner analytics can be read."
              : "This post could not be matched to this account's available media. Sync Insights or use the original post link.",
          );
        } catch (error) {
          notes.push(
            error instanceof PlatformStatsAccessError && error.reason === "identity"
              ? "The platform response did not match this post and account; its counters were discarded."
              : `${source.platform} account analytics could not be read. Check account access and permissions.`,
          );
        }
      }
    }
    const complete = platformPostMetrics[source.platform].every((key) =>
      additions.some((result) => result.counts[key] !== undefined),
    );
    const base = await (deps.publicRead ?? readPublicPostStats)(source.url, {
      trustedMcpWorkspaceId: workspaceId,
      reserve: async () => undefined,
      suppressRendered: complete,
      suppressManaged: additions.some((result) => Object.keys(result.counts).length > 0),
      allowUnavailable: additions.some((result) => Object.keys(result.counts).length),
    });
    if (source.platform === "Instagram" && !additions.length && base.authorHandle) {
      const discoveryConnection = eligible.find(
        (row) =>
          ["instagram", "facebook"].includes(row.provider) &&
          row.scopes.includes("instagram_basic"),
      );
      if (discoveryConnection)
        try {
          const token = await (deps.token ?? accessTokenForConnection)(discoveryConnection);
          const accountId =
            discoveryConnection.provider === "facebook"
              ? await facebookInstagramBusinessAccount(discoveryConnection, token, {
                  signal: AbortSignal.timeout(8_000),
                })
              : discoveryConnection.provider_user_id;
          const result = accountId
            ? await (deps.discovery ?? readInstagramBusinessDiscoveryPost)(
                source.url,
                base.authorHandle,
                accountId,
                token,
                {
                  signal: AbortSignal.timeout(15_000),
                  metaVersion: process.env.POST_STATS_META_GRAPH_API_VERSION || "v27.0",
                },
              )
            : null;
          if (result) additions.push(result);
        } catch {
          notes.push(
            "Instagram Business Discovery could not read this post with the connected account's access.",
          );
        }
    }
    return mergePlatformPostStats(base, additions, [...new Set(notes)]);
  });
}
