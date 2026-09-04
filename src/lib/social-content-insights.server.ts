/* eslint-disable @typescript-eslint/no-explicit-any -- Provider payloads are normalized here. */
import { readResponseText } from "./request-security.server";
import { socialApiErrorMessage, socialApiPayloadHasError } from "./social-provider-response";
import { ProviderError } from "./social-publisher.server";
import type { SocialProvider } from "./social-scheduler";

export type SocialContentInsight = {
  connectionId: string;
  provider: SocialProvider;
  remotePostId: string;
  remotePostUrl: string | null;
  contentType: "text" | "image" | "video" | "carousel" | "link" | "other";
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string;
  views: number | null;
  impressions: number | null;
  reach: number | null;
  engagements: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  fetchedAt: string;
};

type ProviderContentInsight = Omit<SocialContentInsight, "connectionId" | "provider" | "fetchedAt">;

export type LinkedInPostMetric =
  "IMPRESSION" | "MEMBERS_REACHED" | "REACTION" | "COMMENT" | "RESHARE" | "POST_SAVE";

export type SocialContentInsightsPage = {
  content: SocialContentInsight[];
  nextCursor: string | null;
};

type CursorState = Record<string, string | number | boolean>;
type ProviderPage = { items: ProviderContentInsight[]; nextState: CursorState | null };

const LINKEDIN_POST_METRICS: readonly LinkedInPostMetric[] = [
  "IMPRESSION",
  "MEMBERS_REACHED",
  "REACTION",
  "COMMENT",
  "RESHARE",
  "POST_SAVE",
];

function linkedInHeaders() {
  return {
    "LinkedIn-Version": process.env.LINKEDIN_API_VERSION?.trim() || "202606",
    "X-Restli-Protocol-Version": "2.0.0",
    "X-RestLi-Method": "FINDER",
  };
}

export function buildLinkedInPostsUrl(author: string, start = 0) {
  const url = new URL("https://api.linkedin.com/rest/posts");
  url.searchParams.set("author", author);
  url.searchParams.set("q", "author");
  url.searchParams.set("count", "6");
  url.searchParams.set("sortBy", "LAST_MODIFIED");
  if (start) url.searchParams.set("start", String(start));
  return url;
}

export function buildLinkedInMemberPostAnalyticsUrl(entity: string, metric: LinkedInPostMetric) {
  const url = new URL("https://api.linkedin.com/rest/memberCreatorPostAnalytics");
  const entityType = entity.includes(":ugcPost:") ? "ugc" : "share";
  url.searchParams.set("q", "entity");
  url.searchParams.set("entity", `(${entityType}:${entity})`);
  url.searchParams.set("queryType", metric);
  url.searchParams.set("aggregation", "TOTAL");
  return url;
}

function linkedInMetricType(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String(Object.values(value)[0] || "");
  return "";
}

export function normalizeLinkedInPostAnalytics(rows: any[]) {
  const metrics = new Map(
    rows.map((row) => [linkedInMetricType(row?.metricType), count(row?.count)]),
  );
  const likes = metrics.get("REACTION") ?? null;
  const comments = metrics.get("COMMENT") ?? null;
  const shares = metrics.get("RESHARE") ?? null;
  const saves = metrics.get("POST_SAVE") ?? null;
  return {
    impressions: metrics.get("IMPRESSION") ?? null,
    reach: metrics.get("MEMBERS_REACHED") ?? null,
    likes,
    comments,
    shares,
    saves,
    engagements: sum(likes, comments, shares, saves),
  };
}

function count(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return null;
}

function sum(...values: Array<number | null>) {
  const available = values.filter((value): value is number => value !== null);
  return available.length ? available.reduce((total, value) => total + value, 0) : null;
}

function safeCursorState(provider: SocialProvider, state: CursorState) {
  for (const value of Object.values(state)) {
    if (typeof value === "string") {
      if (value.length > 2_048 || /:\/\/|access_token|bearer\s/i.test(value))
        throw new Error(`Unsafe ${provider} pagination cursor.`);
    } else if (
      (typeof value === "number" && (!Number.isFinite(value) || value < 0)) ||
      (typeof value !== "number" && typeof value !== "boolean")
    ) {
      throw new Error(`Invalid ${provider} pagination cursor.`);
    }
  }
  return state;
}

function encodeCursor(provider: SocialProvider, state: CursorState | null) {
  if (!state) return null;
  return btoa(JSON.stringify({ v: 1, p: provider, s: safeCursorState(provider, state) }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(provider: SocialProvider, cursor?: string | null): CursorState {
  if (!cursor) return {};
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const payload = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    if (payload?.v !== 1 || payload?.p !== provider || !payload?.s || Array.isArray(payload.s))
      throw new Error("provider mismatch");
    return safeCursorState(provider, payload.s);
  } catch {
    throw new Error("Invalid social content pagination cursor.");
  }
}

async function providerJson(
  url: string | URL,
  token: string,
  options: { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bento.surf-social-content-insights",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await readResponseText(response, 2 * 1024 * 1024);
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || socialApiPayloadHasError(payload)) {
    throw new ProviderError(
      socialApiErrorMessage(payload, "Historical social content is temporarily unavailable."),
      String(response.status),
      response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  return payload;
}

function graphAfter(payload: any) {
  if (typeof payload?.paging?.cursors?.after === "string") return payload.paging.cursors.after;
  if (typeof payload?.paging?.next !== "string") return null;
  try {
    return new URL(payload.paging.next).searchParams.get("after");
  } catch {
    return null;
  }
}

async function graphPage(url: URL, token: string, after?: string) {
  if (after) url.searchParams.set("after", after);
  const payload = await providerJson(url, token);
  return {
    items: Array.isArray(payload.data) ? payload.data : [],
    after: graphAfter(payload),
  };
}

async function mapInBatches<T, R>(items: T[], size: number, mapper: (item: T) => Promise<R>) {
  const mapped: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    mapped.push(...(await Promise.all(items.slice(index, index + size).map(mapper))));
  }
  return mapped;
}

function unavailableItemInsights(error: unknown) {
  if (
    !(error instanceof ProviderError) ||
    error.retryable ||
    error.status === 401 ||
    (error.status !== 400 && error.status !== 403 && error.status !== 404)
  )
    throw error;
  return { data: [] };
}

function metricMap(payload: any) {
  return new Map<string, number | null>(
    (Array.isArray(payload?.data) ? payload.data : []).map((metric: any) => [
      metric.name,
      count(metric.total_value?.value ?? metric.values?.at(-1)?.value),
    ]),
  );
}

const INSTAGRAM_PAGE_SIZE = 6;
const INSTAGRAM_POST_METRICS = ["views", "reach", "total_interactions", "saved", "shares"];

async function fetchInstagram(
  connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
  const owner = state.source === "me";
  const url = new URL(
    owner
      ? `https://graph.instagram.com/${version}/me/media`
      : `https://graph.instagram.com/${version}/${encodeURIComponent(connection.provider_user_id)}/media`,
  );
  url.searchParams.set(
    "fields",
    "id,caption,media_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count",
  );
  url.searchParams.set("limit", String(INSTAGRAM_PAGE_SIZE));
  let page = await graphPage(url, token, typeof state.after === "string" ? state.after : undefined);
  let source = owner ? "me" : "account";
  if (!page.items.length && !state.after && !owner) {
    const fallbackUrl = new URL(`https://graph.instagram.com/${version}/me/media`);
    fallbackUrl.search = url.search;
    page = await graphPage(fallbackUrl, token);
    source = "me";
  }
  const media = page.items.slice(0, INSTAGRAM_PAGE_SIZE);
  const items = await mapInBatches(media, 6, async (item: any): Promise<ProviderContentInsight> => {
    const metricEntries = await Promise.all(
      INSTAGRAM_POST_METRICS.map(async (metric) => {
        const insights = await providerJson(
          `https://graph.instagram.com/${version}/${encodeURIComponent(item.id)}/insights?metric=${metric}`,
          token,
        ).catch(unavailableItemInsights);
        return [metric, metricMap(insights).get(metric) ?? null] as const;
      }),
    );
    const metrics = new Map(metricEntries);
    const likes = count(item.like_count) ?? metrics.get("likes") ?? null;
    const comments = count(item.comments_count) ?? metrics.get("comments") ?? null;
    const shares = metrics.get("shares") ?? null;
    const saves = metrics.get("saved") ?? null;
    const kind = String(item.media_type || "").toUpperCase();
    return {
      remotePostId: String(item.id),
      remotePostUrl: item.permalink || null,
      contentType:
        kind === "VIDEO"
          ? "video"
          : kind === "CAROUSEL_ALBUM"
            ? "carousel"
            : kind === "IMAGE"
              ? "image"
              : "other",
      caption: item.caption || null,
      thumbnailUrl: item.thumbnail_url || item.media_url || null,
      publishedAt: item.timestamp,
      views: metrics.get("views") ?? null,
      impressions: null,
      reach: metrics.get("reach") ?? null,
      engagements: metrics.get("total_interactions") ?? sum(likes, comments, shares, saves),
      likes,
      comments,
      shares,
      saves,
    };
  });
  return {
    items,
    nextState: page.after ? { after: page.after, source } : null,
  };
}

async function fetchFacebook(
  connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const version = process.env.META_GRAPH_API_VERSION?.trim() || "v25.0";
  const url = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(connection.provider_user_id)}/posts`,
  );
  url.searchParams.set("limit", "25");
  const scopes = new Set<string>(connection.scopes || []);
  url.searchParams.set(
    "fields",
    [
      "id,message,created_time,permalink_url,full_picture,attachments{media_type},shares,comments.limit(0).summary(true),reactions.limit(0).summary(true)",
      scopes.has("read_insights")
        ? "insights.metric(post_media_view,post_total_media_view_unique)"
        : null,
    ]
      .filter(Boolean)
      .join(","),
  );
  const page = await graphPage(
    url,
    token,
    typeof state.after === "string" ? state.after : undefined,
  );
  const items = page.items.slice(0, 25).map((item: any): ProviderContentInsight => {
    const metrics = metricMap(item.insights);
    const likes = count(item.reactions?.summary?.total_count);
    const comments = count(item.comments?.summary?.total_count);
    const shares = count(item.shares?.count);
    const mediaType = String(item.attachments?.data?.[0]?.media_type || "").toLowerCase();
    return {
      remotePostId: String(item.id),
      remotePostUrl: item.permalink_url || null,
      contentType: mediaType.includes("video")
        ? "video"
        : item.full_picture
          ? "image"
          : item.message
            ? "text"
            : "other",
      caption: item.message || null,
      thumbnailUrl: item.full_picture || null,
      publishedAt: item.created_time,
      views: metrics.get("post_media_view") ?? null,
      impressions: null,
      reach: metrics.get("post_total_media_view_unique") ?? null,
      engagements: sum(likes, comments, shares),
      likes,
      comments,
      shares,
      saves: null,
    };
  });
  return { items, nextState: page.after ? { after: page.after } : null };
}

async function fetchThreads(
  connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const owner = state.source === "me";
  const url = new URL(
    owner
      ? "https://graph.threads.net/v1.0/me/threads"
      : `https://graph.threads.net/v1.0/${encodeURIComponent(connection.provider_user_id)}/threads`,
  );
  url.searchParams.set("fields", "id,media_type,text,timestamp,permalink,thumbnail_url,media_url");
  url.searchParams.set("limit", "25");
  let page = await graphPage(url, token, typeof state.after === "string" ? state.after : undefined);
  let source = owner ? "me" : "account";
  if (!page.items.length && !state.after && !owner) {
    const fallbackUrl = new URL("https://graph.threads.net/v1.0/me/threads");
    fallbackUrl.search = url.search;
    page = await graphPage(fallbackUrl, token);
    source = "me";
  }
  const items = await mapInBatches(
    page.items.slice(0, 25),
    6,
    async (item: any): Promise<ProviderContentInsight> => {
      const insights = await providerJson(
        `https://graph.threads.net/v1.0/${encodeURIComponent(item.id)}/insights?metric=views,likes,replies,reposts,quotes,shares`,
        token,
      ).catch(unavailableItemInsights);
      const metrics = metricMap(insights);
      const likes = metrics.get("likes") ?? null;
      const comments = metrics.get("replies") ?? null;
      const shares = sum(
        metrics.get("reposts") ?? null,
        metrics.get("quotes") ?? null,
        metrics.get("shares") ?? null,
      );
      const kind = String(item.media_type || "").toUpperCase();
      return {
        remotePostId: String(item.id),
        remotePostUrl: item.permalink || null,
        contentType: kind === "VIDEO" ? "video" : kind === "IMAGE" ? "image" : "text",
        caption: item.text || null,
        thumbnailUrl: item.thumbnail_url || item.media_url || null,
        publishedAt: item.timestamp,
        views: metrics.get("views") ?? null,
        impressions: null,
        reach: null,
        engagements: sum(likes, comments, shares),
        likes,
        comments,
        shares,
        saves: null,
      };
    },
  );
  return { items, nextState: page.after ? { after: page.after, source } : null };
}

async function fetchTikTok(
  _connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const cursor = typeof state.cursor === "number" ? state.cursor : undefined;
  const payload = await providerJson(
    "https://open.tiktokapis.com/v2/video/list/?fields=id,create_time,cover_image_url,share_url,video_description,title,like_count,comment_count,share_count,view_count",
    token,
    { method: "POST", body: { max_count: 20, ...(cursor !== undefined ? { cursor } : {}) } },
  );
  const source = Array.isArray(payload.data?.videos) ? payload.data.videos.slice(0, 20) : [];
  const items = source.flatMap((item: any): ProviderContentInsight[] => {
    const publishedAt = new Date(Number(item.create_time) * 1_000);
    if (!item.id || !Number.isFinite(publishedAt.getTime())) return [];
    const likes = count(item.like_count);
    const comments = count(item.comment_count);
    const shares = count(item.share_count);
    return [
      {
        remotePostId: String(item.id),
        remotePostUrl: item.share_url || null,
        contentType: "video",
        caption: item.video_description || item.title || null,
        thumbnailUrl: item.cover_image_url || null,
        publishedAt: publishedAt.toISOString(),
        views: count(item.view_count),
        impressions: null,
        reach: null,
        engagements: sum(likes, comments, shares),
        likes,
        comments,
        shares,
        saves: null,
      },
    ];
  });
  const next = count(payload.data?.cursor);
  return {
    items,
    nextState: payload.data?.has_more && next !== null ? { cursor: next } : null,
  };
}

async function fetchTwitter(
  connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const url = new URL(
    `https://api.x.com/2/users/${encodeURIComponent(connection.provider_user_id)}/tweets`,
  );
  url.searchParams.set("max_results", "25");
  url.searchParams.set("exclude", "retweets,replies");
  url.searchParams.set("tweet.fields", "created_at,public_metrics,attachments");
  url.searchParams.set("expansions", "attachments.media_keys");
  url.searchParams.set("media.fields", "media_key,type,url,preview_image_url");
  if (typeof state.paginationToken === "string")
    url.searchParams.set("pagination_token", state.paginationToken);
  const payload = await providerJson(url, token);
  const source = Array.isArray(payload.data) ? payload.data.slice(0, 25) : [];
  const organicById = new Map<string, any>();
  const ids = source.flatMap((item: any) => (item.id ? [String(item.id)] : []));
  if (ids.length) {
    const organicUrl = new URL("https://api.x.com/2/tweets");
    organicUrl.searchParams.set("ids", ids.join(","));
    organicUrl.searchParams.set("tweet.fields", "organic_metrics");
    const organicPayload = await providerJson(organicUrl, token).catch(() => null);
    for (const item of Array.isArray(organicPayload?.data) ? organicPayload.data : []) {
      if (item.id && item.organic_metrics) organicById.set(String(item.id), item.organic_metrics);
    }
  }
  const media = new Map<string, any>(
    (Array.isArray(payload.includes?.media) ? payload.includes.media : []).map((item: any) => [
      item.media_key,
      item,
    ]),
  );
  const items = source.flatMap((item: any): ProviderContentInsight[] => {
    if (!item.id || !Number.isFinite(Date.parse(item.created_at || ""))) return [];
    const metrics = { ...(item.public_metrics || {}), ...(organicById.get(String(item.id)) || {}) };
    const likes = count(metrics.like_count);
    const comments = count(metrics.reply_count);
    const shares = sum(count(metrics.retweet_count), count(metrics.quote_count));
    const attachment = media.get(item.attachments?.media_keys?.[0]);
    return [
      {
        remotePostId: String(item.id),
        remotePostUrl: `https://x.com/${encodeURIComponent(connection.provider_handle)}/status/${encodeURIComponent(item.id)}`,
        contentType:
          attachment?.type === "video" || attachment?.type === "animated_gif"
            ? "video"
            : attachment
              ? "image"
              : "text",
        caption: item.text || null,
        thumbnailUrl: attachment?.preview_image_url || attachment?.url || null,
        publishedAt: item.created_at,
        views: null,
        impressions: count(metrics.impression_count),
        reach: null,
        engagements: sum(likes, comments, shares, count(metrics.bookmark_count)),
        likes,
        comments,
        shares,
        saves: count(metrics.bookmark_count),
      },
    ];
  });
  const next = typeof payload.meta?.next_token === "string" ? payload.meta.next_token : null;
  return { items, nextState: next ? { paginationToken: next } : null };
}

async function fetchLinkedIn(
  connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const scopes = new Set<string>(connection.scopes || []);
  if (!scopes.has("r_member_social") || !scopes.has("r_member_postAnalytics")) {
    return { items: [], nextState: null };
  }
  const start = typeof state.start === "number" && state.start >= 0 ? state.start : 0;
  const payload = await providerJson(
    buildLinkedInPostsUrl(connection.provider_user_id, start),
    token,
    {
      headers: linkedInHeaders(),
    },
  );
  const pagePosts = Array.isArray(payload.elements) ? payload.elements.slice(0, 6) : [];
  const posts = pagePosts.filter((post: any) => {
    const publishedAt = Number(post.publishedAt ?? post.createdAt);
    return post.id && Number.isFinite(publishedAt) && publishedAt > 0;
  });
  const insights: ProviderContentInsight[] = [];

  // Six posts × six metrics plus the finder request stays below the 50-subrequest ceiling.
  for (let index = 0; index < posts.length; index += 3) {
    const batch = posts.slice(index, index + 3);
    insights.push(
      ...(await Promise.all(
        batch.map(async (post: any): Promise<ProviderContentInsight> => {
          const metricRows = (
            await Promise.all(
              LINKEDIN_POST_METRICS.map(async (metric) => {
                try {
                  const analytics = await providerJson(
                    buildLinkedInMemberPostAnalyticsUrl(String(post.id), metric),
                    token,
                    { headers: linkedInHeaders() },
                  );
                  return Array.isArray(analytics.elements) ? analytics.elements : [];
                } catch (error) {
                  if (metric === "IMPRESSION") throw error;
                  return [];
                }
              }),
            )
          ).flat();
          const metrics = normalizeLinkedInPostAnalytics(metricRows);
          const content = post.content || {};
          const mediaId = String(content.media?.id || "");
          const publishedAt = Number(post.publishedAt || post.createdAt);
          return {
            remotePostId: String(post.id),
            remotePostUrl: post.id ? `https://www.linkedin.com/feed/update/${post.id}/` : null,
            contentType: content.multiImage
              ? "carousel"
              : mediaId
                ? mediaId.includes(":video:")
                  ? "video"
                  : "image"
                : content.article
                  ? "link"
                  : post.commentary
                    ? "text"
                    : "other",
            caption: post.commentary || content.article?.title || null,
            thumbnailUrl:
              typeof content.article?.thumbnail === "string" ? content.article.thumbnail : null,
            publishedAt: new Date(publishedAt).toISOString(),
            views: null,
            ...metrics,
          };
        }),
      )),
    );
  }
  return {
    items: insights,
    nextState: pagePosts.length === 6 ? { start: start + pagePosts.length } : null,
  };
}

async function fetchYouTube(
  connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const channel = await providerJson(
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
    token,
  );
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { items: [], nextState: null };
  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  playlistUrl.searchParams.set("part", "contentDetails");
  playlistUrl.searchParams.set("playlistId", uploads);
  playlistUrl.searchParams.set("maxResults", "50");
  if (typeof state.pageToken === "string")
    playlistUrl.searchParams.set("pageToken", state.pageToken);
  const playlist = await providerJson(playlistUrl, token);
  const playlistItems = Array.isArray(playlist.items) ? playlist.items.slice(0, 50) : [];
  const ids = playlistItems.flatMap((item: any) =>
    item.contentDetails?.videoId ? [String(item.contentDetails.videoId)] : [],
  );
  let videos: any[] = [];
  if (ids.length) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics");
    url.searchParams.set("id", ids.join(","));
    url.searchParams.set("maxResults", "50");
    const payload = await providerJson(url, token);
    videos = Array.isArray(payload.items) ? payload.items : [];
  }
  const analytics = new Map<string, Record<string, number | null>>();
  if (
    ids.length &&
    (connection.scopes || []).includes("https://www.googleapis.com/auth/yt-analytics.readonly")
  ) {
    const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
    url.searchParams.set("ids", "channel==MINE");
    url.searchParams.set("startDate", "2005-04-23");
    url.searchParams.set("endDate", new Date().toISOString().slice(0, 10));
    url.searchParams.set("dimensions", "video");
    url.searchParams.set("metrics", "views,likes,comments,shares");
    url.searchParams.set("filters", `video==${ids.join(",")}`);
    url.searchParams.set("maxResults", "50");
    const payload = await providerJson(url, token).catch(() => null);
    const headers = (payload?.columnHeaders || []).map((header: any) => header.name);
    for (const row of Array.isArray(payload?.rows) ? payload.rows : []) {
      const values = Object.fromEntries(
        headers.map((header: string, index: number) => [header, count(row[index])]),
      );
      if (typeof row[headers.indexOf("video")] === "string")
        analytics.set(row[headers.indexOf("video")], values);
    }
  }
  const items = videos.flatMap((item): ProviderContentInsight[] => {
    if (!item.id || !Number.isFinite(Date.parse(item.snippet?.publishedAt || ""))) return [];
    const report = analytics.get(String(item.id));
    const likes = report?.likes ?? count(item.statistics?.likeCount);
    const comments = report?.comments ?? count(item.statistics?.commentCount);
    const shares = report?.shares ?? null;
    return [
      {
        remotePostId: String(item.id),
        remotePostUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`,
        contentType: "video",
        caption: item.snippet?.title || item.snippet?.description || null,
        thumbnailUrl:
          item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url || null,
        publishedAt: item.snippet?.publishedAt,
        views: report?.views ?? count(item.statistics?.viewCount),
        impressions: null,
        reach: null,
        engagements: sum(likes, comments, shares),
        likes,
        comments,
        shares,
        saves: null,
      },
    ];
  });
  const next = typeof playlist.nextPageToken === "string" ? playlist.nextPageToken : null;
  return { items, nextState: next ? { pageToken: next } : null };
}

async function fetchReddit(
  connection: any,
  token: string,
  state: CursorState,
): Promise<ProviderPage> {
  const url = new URL(
    `https://oauth.reddit.com/user/${encodeURIComponent(connection.provider_handle)}/submitted`,
  );
  url.searchParams.set("limit", "25");
  url.searchParams.set("raw_json", "1");
  if (typeof state.after === "string") url.searchParams.set("after", state.after);
  const payload = await providerJson(url, token, {
    headers: { "User-Agent": "web:bento.surf.social-insights:v1.0 (by /u/bentosurf)" },
  });
  const children = Array.isArray(payload.data?.children) ? payload.data.children.slice(0, 25) : [];
  const items = children.flatMap(({ data: item }: any): ProviderContentInsight[] => {
    const publishedAt = new Date(Number(item.created_utc) * 1_000);
    if (!item.name && !item.id) return [];
    if (!Number.isFinite(publishedAt.getTime())) return [];
    return [
      {
        remotePostId: String(item.name || item.id),
        remotePostUrl: item.permalink ? `https://www.reddit.com${item.permalink}` : null,
        contentType: item.is_video
          ? "video"
          : item.post_hint === "image"
            ? "image"
            : item.is_self
              ? "text"
              : "link",
        caption: item.title || item.selftext || null,
        thumbnailUrl:
          typeof item.thumbnail === "string" && item.thumbnail.startsWith("http")
            ? item.thumbnail
            : null,
        publishedAt: publishedAt.toISOString(),
        views: null,
        impressions: null,
        reach: null,
        engagements: sum(count(item.score), count(item.num_comments)),
        likes: null,
        comments: count(item.num_comments),
        shares: null,
        saves: null,
      },
    ];
  });
  const next = typeof payload.data?.after === "string" ? payload.data.after : null;
  return { items, nextState: next ? { after: next } : null };
}

export async function fetchSocialContentInsightsPage(
  connection: any,
  token: string,
  cursor?: string | null,
): Promise<SocialContentInsightsPage> {
  const provider = connection.provider as SocialProvider;
  const state = decodeCursor(provider, cursor);
  let page: ProviderPage = { items: [], nextState: null };
  if (provider === "instagram") page = await fetchInstagram(connection, token, state);
  else if (provider === "facebook") page = await fetchFacebook(connection, token, state);
  else if (provider === "threads") page = await fetchThreads(connection, token, state);
  else if (provider === "tiktok") page = await fetchTikTok(connection, token, state);
  else if (provider === "linkedin") page = await fetchLinkedIn(connection, token, state);
  else if (provider === "twitter") page = await fetchTwitter(connection, token, state);
  else if (provider === "youtube") page = await fetchYouTube(connection, token, state);
  else if (provider === "reddit") page = await fetchReddit(connection, token, state);
  const fetchedAt = new Date().toISOString();
  return {
    content: page.items.map((item) => ({
      ...item,
      connectionId: connection.id,
      provider,
      fetchedAt,
    })),
    nextCursor: encodeCursor(provider, page.nextState),
  };
}

export async function fetchSocialContentInsights(
  connection: any,
  token: string,
): Promise<SocialContentInsight[]> {
  const content: SocialContentInsight[] = [];
  let cursor: string | null = null;
  // Compatibility for callers being migrated to durable page-by-page queue processing.
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await fetchSocialContentInsightsPage(connection, token, cursor);
    content.push(...page.content);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return content;
}
