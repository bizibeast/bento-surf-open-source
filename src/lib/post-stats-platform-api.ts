import {
  normalizePublicPostUrl,
  type PublicPostMetric,
  type PostStatsEvidence,
} from "./public-post-stats";
import { discoverPostKey } from "./content-discover-identity";
import { readResponseText } from "./request-security.server";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export type PlatformPostStats = {
  counts: Partial<Record<PublicPostMetric, number>>;
  evidence: Partial<Record<PublicPostMetric, PostStatsEvidence>>;
  notes?: string[];
};
export type PostStatsConnection = {
  id: string;
  provider: string;
  provider_user_id: string;
  provider_handle: string;
  scopes: string[];
  status: string;
};
type Options = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  metaVersion?: string;
  linkedInVersion?: string;
};
export class PlatformStatsAccessError extends Error {
  constructor(readonly reason: "permission" | "unavailable" | "identity" | "limit") {
    super(reason);
  }
}

/** A per-lookup request ceiling, including pagination and individual metric reads. */
function reader(token: string, options: Options) {
  let calls = 0;
  return async (url: URL, headers: Record<string, string> = {}) => {
    if (++calls > 18) throw new PlatformStatsAccessError("limit");
    const response = await (options.fetcher ?? fetch)(url, {
      headers: { ...headers, authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.any([
        options.signal ?? AbortSignal.timeout(25_000),
        AbortSignal.timeout(8_000),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformStatsAccessError(
        response.status === 429
          ? "limit"
          : [401, 403].includes(response.status)
            ? "permission"
            : "unavailable",
      );
    }
    let data: ObjectValue;
    try {
      data = object(JSON.parse(await readResponseText(response, 512 * 1024)));
    } catch {
      throw new PlatformStatsAccessError("unavailable");
    }
    if (data.error)
      throw new PlatformStatsAccessError(
        [4, 17, 32, 613].includes(Number(object(data.error).code)) ? "limit" : "permission",
      );
    return data;
  };
}
const metaVersion = (value?: string) => (/^v\d+\.0$/.test(value || "") ? value! : "v25.0");
const identity = (url: string) => discoverPostKey({ sourceUrl: url });
function add(
  result: PlatformPostStats,
  key: PublicPostMetric,
  value: unknown,
  source: Omit<PostStatsEvidence, "observedAt">,
) {
  const n = count(value);
  if (n !== null) {
    result.counts[key] = n;
    result.evidence[key] = { ...source, observedAt: new Date().toISOString() };
  }
}
const ownedEvidence = (
  platform: string,
  definition: string,
): Omit<PostStatsEvidence, "observedAt"> => ({
  kind: "platform_api",
  label: `${platform} account analytics`,
  precision: "reported",
  definition,
  visibility: "workspace",
});

/** Resolve only the selected account's recent media. Never follow provider pagination URLs. */
export async function readOwnedInstagramPost(
  sourceUrl: string,
  connection: PostStatsConnection,
  token: string,
  indexedMediaId: string | undefined,
  options: Options = {},
): Promise<PlatformPostStats | null> {
  if (connection.provider !== "instagram" || connection.status !== "active") return null;
  const scopes = new Set(connection.scopes);
  const instagramLogin = scopes.has("instagram_business_basic");
  if (
    !(instagramLogin
      ? scopes.has("instagram_business_manage_insights")
      : scopes.has("instagram_basic") && scopes.has("instagram_manage_insights"))
  )
    throw new PlatformStatsAccessError("permission");
  if (!/^\d{1,30}$/.test(connection.provider_user_id))
    throw new PlatformStatsAccessError("identity");
  const base = `https://${instagramLogin ? "graph.instagram.com" : "graph.facebook.com"}/${metaVersion(options.metaVersion)}`;
  const read = reader(token, options);
  let media: ObjectValue | undefined;
  if (indexedMediaId && /^\d{1,30}$/.test(indexedMediaId)) {
    const url = new URL(`${base}/${indexedMediaId}`);
    url.searchParams.set(
      "fields",
      "id,owner,permalink,like_count,comments_count,media_type,media_product_type",
    );
    media = await read(url);
  } else {
    let after: string | undefined;
    for (let page = 0; page < 2; page++) {
      const url = new URL(`${base}/${connection.provider_user_id}/media`);
      url.searchParams.set(
        "fields",
        "id,owner,permalink,like_count,comments_count,media_type,media_product_type",
      );
      url.searchParams.set("limit", "25");
      if (after) url.searchParams.set("after", after);
      const data = await read(url);
      media = list(data.data)
        .map(object)
        .find(
          (item) =>
            typeof item.permalink === "string" && identity(item.permalink) === identity(sourceUrl),
        );
      if (media) break;
      const cursor = object(object(data.paging).cursors).after;
      if (typeof cursor !== "string" || cursor.length > 2048 || cursor === after) break;
      after = cursor;
    }
  }
  if (!media) return null;
  const owner = typeof media.owner === "string" ? media.owner : object(media.owner).id;
  const permalinkMatches =
    typeof media.permalink === "string" && identity(media.permalink) === identity(sourceUrl);
  const mediaIdMatches =
    /^\d{1,30}$/.test(String(media.id)) && (!indexedMediaId || String(media.id) === indexedMediaId);
  let ownerMatches = owner === connection.provider_user_id;
  let profileCanonicalMatches = false;
  if (
    !ownerMatches &&
    instagramLogin &&
    permalinkMatches &&
    mediaIdMatches &&
    typeof owner === "string" &&
    /^\d{1,30}$/.test(owner)
  ) {
    const profileUrl = new URL(`${base}/me`);
    profileUrl.searchParams.set("fields", "id,user_id");
    const profile = await read(profileUrl);
    // Existing connections store user_id when present. Media.owner can instead
    // contain the app-scoped id. Bind both aliases to this token's canonical
    // profile before accepting either; a matching username is never enough.
    const canonicalId = profile.user_id ?? profile.id;
    profileCanonicalMatches = canonicalId === connection.provider_user_id;
    ownerMatches = profileCanonicalMatches && [profile.id, profile.user_id].includes(owner);
  }
  if (!ownerMatches || !permalinkMatches || !mediaIdMatches) {
    console.warn("Instagram post identity verification failed", {
      ownerPresent: typeof owner === "string",
      ownerMatches,
      profileCanonicalMatches,
      permalinkMatches,
      mediaIdMatches,
    });
    throw new PlatformStatsAccessError("identity");
  }
  const result: PlatformPostStats = { counts: {}, evidence: {} };
  add(
    result,
    "likes",
    media.like_count,
    ownedEvidence("Instagram", "Likes on this media; excludes separate promoted-post surfaces."),
  );
  add(
    result,
    "comments",
    media.comments_count,
    ownedEvidence("Instagram", "Comments and replies reported for this media."),
  );
  // Individual reads isolate unsupported metrics; never retry a failed metric.
  for (const [key, metric, definition] of [
    ["views", "views", "Times the media was played or displayed; includes repeat views."],
    ["reach", "reach", "Accounts reached; a platform-estimated unique audience."],
    ["shares", "shares", "Shares reported by Instagram Insights."],
    ["saves", "saved", "Saves reported by Instagram Insights."],
    ["reposts", "reposts", "Reposts reported by Instagram Insights."],
  ] as const) {
    const url = new URL(`${base}/${String(media.id)}/insights`);
    url.searchParams.set("metric", metric);
    try {
      const data = await read(url);
      const row = list(data.data)
        .map(object)
        .find((item) => item.name === metric);
      if (!row) continue;
      const value = object(list(row.values)[0]).value ?? object(row.total_value).value;
      add(result, key, value, ownedEvidence("Instagram", definition));
    } catch (error) {
      if (!(error instanceof PlatformStatsAccessError)) throw error;
      if (error.reason === "limit" || error.reason === "permission") {
        result.notes = [
          error.reason === "limit"
            ? "Instagram rate-limited the remaining insights. Try again later."
            : "Instagram rejected Insights access. The remaining private metrics need valid account permission.",
        ];
        break;
      }
    }
  }
  return result;
}

export async function readInstagramBusinessDiscoveryPost(
  sourceUrl: string,
  handle: string,
  accountId: string,
  token: string,
  options: Options = {},
): Promise<PlatformPostStats | null> {
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle) || !/^\d{1,30}$/.test(accountId))
    throw new PlatformStatsAccessError("identity");
  const read = reader(token, options);
  let after: string | undefined;
  // At most 50 media objects. Old posts outside this bound retain public extraction.
  for (let page = 0; page < 2; page++) {
    const url = new URL(
      `https://graph.facebook.com/${metaVersion(options.metaVersion)}/${accountId}`,
    );
    const cursor = after ? `.after(${JSON.stringify(after)})` : "";
    url.searchParams.set(
      "fields",
      `business_discovery.username(${handle}){username,media.limit(25)${cursor}{id,shortcode,permalink,like_count,comments_count,view_count}}`,
    );
    const data = await read(url);
    const profile = object(data.business_discovery);
    if (String(profile.username).toLowerCase() !== handle.toLowerCase())
      throw new PlatformStatsAccessError("identity");
    const media = object(profile.media);
    const item = list(media.data)
      .map(object)
      .find(
        (item) =>
          typeof item.permalink === "string" && identity(item.permalink) === identity(sourceUrl),
      );
    if (item) {
      const result: PlatformPostStats = { counts: {}, evidence: {} };
      for (const [key, field, definition] of [
        [
          "likes",
          "like_count",
          "Public likes on this media, excluding separate promoted-post surfaces.",
        ],
        ["comments", "comments_count", "Public comments and replies on this media."],
        [
          "views",
          "view_count",
          "Reel views including paid and organic; may include accessible crossposted Facebook views.",
        ],
      ] as const)
        add(result, key, item[field], {
          kind: "business_discovery",
          label: "Instagram Business Discovery",
          precision: "reported",
          definition,
          visibility: "public",
        });
      return result;
    }
    const next = object(media.cursors).after ?? object(object(media.paging).cursors).after;
    if (typeof next !== "string" || !/^[A-Za-z0-9_=-]{1,2048}$/.test(next) || next === after) break;
    after = next;
  }
  return null;
}

export async function facebookInstagramBusinessAccount(
  connection: PostStatsConnection,
  token: string,
  options: Options = {},
) {
  if (
    connection.provider !== "facebook" ||
    connection.status !== "active" ||
    !connection.scopes.includes("instagram_basic") ||
    !/^\d{1,30}$/.test(connection.provider_user_id)
  )
    return null;
  const url = new URL(
    `https://graph.facebook.com/${metaVersion(options.metaVersion)}/${connection.provider_user_id}`,
  );
  url.searchParams.set("fields", "instagram_business_account{id}");
  const data = await reader(token, options)(url);
  const id = object(data.instagram_business_account).id;
  return typeof id === "string" && /^\d{1,30}$/.test(id) ? id : null;
}

export async function readOwnedLinkedInPost(
  sourceUrl: string,
  connection: PostStatsConnection,
  token: string,
  indexedPostId: string | undefined,
  options: Options = {},
): Promise<PlatformPostStats | null> {
  if (connection.provider !== "linkedin" || connection.status !== "active") return null;
  if (
    !connection.scopes.includes("r_member_postAnalytics") ||
    !connection.scopes.includes("r_member_social")
  )
    throw new PlatformStatsAccessError("permission");
  const source = normalizePublicPostUrl(sourceUrl);
  if (source?.platform !== "LinkedIn") throw new PlatformStatsAccessError("identity");
  // Activity IDs are not assumed to be share IDs. An exact stored permalink
  // association from this workspace's Insights is required for activity URLs.
  const direct = new URL(source.url).pathname.match(/urn:li:(?:share|ugcPost):\d+$/)?.[0];
  const postId = indexedPostId ?? direct;
  if (!postId || !/^urn:li:(?:share|ugcPost):\d{1,24}$/.test(postId)) return null;
  const read = reader(token, options);
  const headers = {
    "LinkedIn-Version": /^\d{6}$/.test(options.linkedInVersion || "")
      ? options.linkedInVersion!
      : "202606",
    "X-Restli-Protocol-Version": "2.0.0",
  };
  const post = await read(
    new URL(`https://api.linkedin.com/rest/posts/${encodeURIComponent(postId)}`),
    headers,
  );
  if (post.id !== postId || post.author !== connection.provider_user_id)
    throw new PlatformStatsAccessError("identity");
  const result: PlatformPostStats = { counts: {}, evidence: {} };
  const isVideo = String(object(object(post.content).media).id).startsWith("urn:li:video:");
  for (const [key, metric, definition] of [
    [
      "impressions",
      "IMPRESSION",
      "Times the post was displayed; not video plays or unique viewers.",
    ],
    ["reach", "MEMBERS_REACHED", "Members reached by this post."],
    ["likes", "REACTION", "Reactions to this post."],
    ["comments", "COMMENT", "Comments reported for this post."],
    ["reposts", "RESHARE", "Reshares of this post."],
    ["saves", "POST_SAVE", "Times this post was saved."],
    ["sends", "POST_SEND", "Times this post was sent through LinkedIn messaging."],
    ["link_clicks", "LINK_CLICKS", "Link clicks attributed to this post."],
    ...(isVideo
      ? [
          [
            "views",
            "VIDEO_PLAY",
            "Video plays lasting at least two seconds; automatic loops are not additional plays.",
          ],
          ["unique_viewers", "VIDEO_VIEWER", "Unique members who made engaged video plays."],
          [
            "watch_time_ms",
            "VIDEO_WATCH_TIME",
            "Total video watch time in milliseconds, including automatic loops.",
          ],
        ]
      : []),
  ] as Array<[PublicPostMetric, string, string]>) {
    const url = new URL(
      `https://api.linkedin.com/rest/${metric.startsWith("VIDEO_") ? "memberCreatorVideoAnalytics" : "memberCreatorPostAnalytics"}`,
    );
    url.searchParams.set("q", "entity");
    url.searchParams.set("entity", `(${postId.includes(":ugcPost:") ? "ugc" : "share"}:${postId})`);
    url.searchParams.set("queryType", metric);
    url.searchParams.set("aggregation", "TOTAL");
    try {
      const data = await read(url, { ...headers, "X-RestLi-Method": "FINDER" });
      const rows = list(data.elements)
        .map(object)
        .filter((row) => {
          const target = row.targetEntity;
          return (
            (typeof target === "string" ? target : Object.values(object(target))[0]) === postId
          );
        });
      const row = rows.find(
        (row) =>
          (typeof row.metricType === "string"
            ? row.metricType
            : Object.values(object(row.metricType))[0]) === metric,
      );
      if (row) add(result, key, row.count, ownedEvidence("LinkedIn", definition));
    } catch (error) {
      if (!(error instanceof PlatformStatsAccessError)) throw error;
      if (error.reason === "limit" || error.reason === "permission") {
        result.notes = [
          error.reason === "limit"
            ? "LinkedIn rate-limited the remaining analytics. Try again later."
            : "LinkedIn rejected analytics access. The remaining private metrics need valid account permission.",
        ];
        break;
      }
    }
  }
  return result;
}
