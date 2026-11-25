import {
  normalizePublicPostUrl,
  platformPostMetrics,
  publicPostMetricLabels,
  PUBLIC_POST_STATS_PATH,
  type PublicPostStats,
  type PostStatsEvidence,
  type PublicPostMetric,
} from "./public-post-stats";
import { publicPostCountEvidence, publicPostMetadata } from "./content-source-enrichment.server";
import { discoverPostKey } from "./content-discover-identity";
import {
  enforceTurnstileRequest,
  readRequestText,
  readResponseText,
  RequestHttpError,
  RequestBodyTooLargeError,
  type TurnstileEnv,
} from "./request-security.server";
import { reserveProviderUsage, ProviderBudgetError } from "./provider-budget.server";
import { twitterSyndicationUrl } from "./public-social-url";

export type PublicPostStatsEnv = TurnstileEnv & {
  COBALT_API_URL?: string;
  COBALT_API_KEY?: string;
  FREE_TOOLS_MEDIA_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  BROWSER?: unknown;
  POST_STATS_MANAGED_ENABLED?: string;
  BRIGHT_DATA_API_KEY?: string;
};
type Dependencies = {
  env?: PublicPostStatsEnv;
  fetcher?: typeof fetch;
  cache?: Pick<Cache, "match" | "put"> | null;
  /** Set only after MCP authentication and workspace ownership have been checked. */
  trustedMcpWorkspaceId?: string;
  reserve?: typeof reserveProviderUsage;
  suppressRendered?: boolean;
  suppressManaged?: boolean;
  allowUnavailable?: boolean;
  useConnectedAccounts?: boolean;
  rendered?: (url: string) => Promise<{
    value: string;
    counts?: Partial<Record<PublicPostMetric, number>>;
    precision?: Partial<Record<PublicPostMetric, "rounded" | "unknown">>;
    requiresSignIn?: readonly PublicPostMetric[];
  }>;
  managed?: typeof import("./post-stats-managed.server").readManagedPublicPostStats;
};
class PostStatsExtractorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Public pages can append megabytes of recommendations after useful post metadata.
 * Keep a bounded prefix and parse only complete, identity-matched records within it. */
async function readPublicPostPrefix(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = 3 * 1024 * 1024;
  let text = "";
  let ended = false;
  try {
    while (remaining > 0) {
      const part = await reader.read();
      if (part.done) {
        ended = true;
        break;
      }
      const bytes = part.value.subarray(0, remaining);
      remaining -= bytes.length;
      text += decoder.decode(bytes, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
  }
}

export async function readPublicPostStats(
  input: string,
  deps: Dependencies = {},
): Promise<PublicPostStats> {
  const source = normalizePublicPostUrl(input);
  if (!source)
    throw new RequestHttpError(
      400,
      "Paste a public post or video link from Instagram, YouTube, TikTok, LinkedIn, X, Facebook, Threads or Reddit.",
    );
  const cache =
    deps.cache === undefined
      ? typeof caches === "undefined"
        ? undefined
        : (caches as CacheStorage & { default: Cache }).default
      : deps.cache;
  const cacheKey = new Request(
    `http://localhost:8080/__cache/public-post-stats/v8/${encodeURIComponent(source.url)}`,
  );
  try {
    const hit = await cache?.match(cacheKey);
    if (hit) return { ...((await hit.json()) as PublicPostStats), cached: true };
  } catch {
    /* A cache outage may not turn a bounded public read into a failure. */
  }
  if (deps.trustedMcpWorkspaceId)
    await (deps.reserve ?? reserveProviderUsage)("mcp_media_resolutions", 1, {
      workspaceId: deps.trustedMcpWorkspaceId,
    });
  else if (
    ["YouTube", "TikTok", "Facebook"].includes(source.platform) &&
    (deps.env ?? (globalThis.__env__ as PublicPostStatsEnv | undefined))?.COBALT_API_URL
  )
    await (deps.reserve ?? reserveProviderUsage)("mcp_media_resolutions", 1);
  const fetcher = deps.fetcher ?? fetch;
  const signal = AbortSignal.timeout(
    ["YouTube", "TikTok"].includes(source.platform) ? 48_000 : 20_000,
  );
  let current = source;
  let targetUrl = source.url;
  let expectedIdentity = source.short ? null : discoverPostKey({ sourceUrl: source.url });
  const evidence: ReturnType<typeof publicPostCountEvidence> = {};
  let extractionMethod: string | undefined;
  let authorHandle: string | undefined;
  const metricEvidence: Partial<Record<PublicPostMetric, PostStatsEvidence>> = {};
  const unverified = new Set<PublicPostMetric>();
  const signInRequired = new Set<PublicPostMetric>();
  const markEvidence = (
    key: PublicPostMetric,
    kind: "public_metadata" | "rendered_page",
    label: string,
  ) => {
    metricEvidence[key] = {
      kind,
      label,
      observedAt: new Date().toISOString(),
      precision: "unknown",
      visibility: "public",
      definition:
        key === "views" && source.platform === "LinkedIn"
          ? "Publicly displayed view counter; not verified as post impressions or unique viewers."
          : "Counter exposed for this post by the public source; its display may be rounded.",
    };
  };
  let resolvedFromRepost = false;
  const env = deps.env ?? ((globalThis.__env__ ?? {}) as PublicPostStatsEnv);
  const managed =
    !deps.suppressManaged && env.POST_STATS_MANAGED_ENABLED === "true"
      ? (deps.managed ?? (await import("./post-stats-managed.server")).readManagedPublicPostStats)
      : undefined;
  const managedOptions = {
    enabled: true,
    apiKey: env.BRIGHT_DATA_API_KEY,
    cache,
    workspaceId: deps.trustedMcpWorkspaceId,
  };
  type ManagedResult = Awaited<ReturnType<NonNullable<Dependencies["managed"]>>>;
  const applyManaged = (supplement: ManagedResult) => {
    for (const [key, value] of Object.entries(supplement.counts)) {
      const metric = key as PublicPostMetric;
      if (evidence[metric] !== undefined || value === undefined) continue;
      evidence[metric] = value;
      metricEvidence[metric] = {
        kind: "managed_public",
        label: "Bright Data public post",
        precision: "unknown",
        observedAt: supplement.observedAt ?? new Date().toISOString(),
        visibility: "public",
        definition:
          metric === "reshares"
            ? "Combined repost and quote total reported for this post; distinct from the separate repost/quote counters."
            : metric === "score"
              ? "Public Reddit score supplied as num_upvotes; Reddit scores may be fuzzed."
              : "Public counter retrieved for this exact post by Bright Data; may be rounded or differ from another platform surface.",
      };
      unverified.delete(metric);
    }
  };
  const resumed = managed
    ? await managed(current.url, platformPostMetrics[source.platform], {
        ...managedOptions,
        onlyExisting: true,
      })
    : undefined;
  const resumedComplete =
    resumed?.status === "available" &&
    platformPostMetrics[source.platform].every(
      (key) =>
        resumed.counts[key] !== undefined || (source.platform === "Instagram" && key === "saves"),
    );
  if (resumedComplete) applyManaged(resumed!);
  let extractionError: PostStatsExtractorError | undefined;
  if (!resumedComplete && env.COBALT_API_URL && env.COBALT_API_KEY) {
    try {
      const endpoint = new URL("/post-stats", env.COBALT_API_URL);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
        throw new Error("Invalid media service");
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Api-Key ${env.COBALT_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: source.url }),
        redirect: "manual",
        signal,
      });
      const result = JSON.parse(await readResponseText(response, 32_768)) as {
        sourceUrl?: string;
        counts?: Record<string, unknown>;
        method?: string;
        resolvedFromRepost?: boolean;
        error?: string;
        authorHandle?: string;
      };
      if (!response.ok)
        throw new PostStatsExtractorError(
          response.status === 429 ? 429 : 502,
          result.error || "The metadata extractor could not read this post.",
        );
      const resolved = normalizePublicPostUrl(result.sourceUrl);
      if (
        !resolved ||
        resolved.platform !== source.platform ||
        (!source.short &&
          discoverPostKey({ sourceUrl: resolved.url }) !== expectedIdentity &&
          !(source.platform === "X" && result.resolvedFromRepost === true))
      )
        throw new Error("Extractor returned a different post");
      current = resolved;
      resolvedFromRepost = result.resolvedFromRepost === true;
      extractionMethod = result.method;
      if (
        source.platform === "Instagram" &&
        /^[A-Za-z0-9._]{1,30}$/.test(result.authorHandle || "")
      )
        authorHandle = result.authorHandle;
      for (const [key, value] of Object.entries(result.counts ?? {}))
        if (
          ["views", "likes", "comments", "shares", "reposts", "quotes", "saves", "score"].includes(
            key,
          ) &&
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          (value >= 0 || key === "score")
        ) {
          evidence[key as keyof typeof evidence] = value;
          markEvidence(
            key as PublicPostMetric,
            "public_metadata",
            result.method === "instagram-download-metadata"
              ? "Instagram public embed"
              : result.method === "native-video-extractor"
                ? `${source.platform} video metadata`
                : `${source.platform} public post data`,
          );
        }
    } catch (error) {
      if (error instanceof PostStatsExtractorError && error.status === 429)
        throw new RequestHttpError(
          429,
          "The extraction service is busy or its current quota is exhausted. Please try again later.",
        );
      extractionError =
        error instanceof PostStatsExtractorError
          ? error
          : new PostStatsExtractorError(502, "The metadata extractor could not read this post.");
    }
  }
  // The extractor is the primary path. Public-page evidence only supplements it.
  if (
    platformPostMetrics[source.platform].some(
      (key) => evidence[key] === undefined && !(source.platform === "Instagram" && key === "saves"),
    )
  ) {
    try {
      if (source.platform === "X") {
        const id = new URL(source.url).pathname.match(/\/status\/(\d+)/)?.[1] || "";
        const endpoint = twitterSyndicationUrl(id);
        if (!endpoint) throw new Error("Invalid X post");
        const response = await fetcher(endpoint, {
          redirect: "manual",
          signal,
          headers: { Accept: "application/json" },
        });
        if (
          !response.ok ||
          response.status >= 300 ||
          !response.headers.get("content-type")?.includes("application/json")
        ) {
          await response.body?.cancel();
          throw new Error("Public embed unavailable");
        }
        const post = JSON.parse(await readResponseText(response, 128_000)) as Record<
          string,
          unknown
        >;
        if (
          post.id_str !== id ||
          post.__typename === "TweetTombstone" ||
          post.__typename === "TweetUnavailable"
        )
          throw new Error("Post identity unavailable");
        for (const [key, field] of [
          ["likes", "favorite_count"],
          ["comments", "conversation_count"],
          ["reposts", "retweet_count"],
          ["quotes", "quote_count"],
          ["views", "view_count"],
        ] as const) {
          const value = post[field];
          const count =
            typeof value === "number"
              ? value
              : typeof value === "string" && /^\d+$/.test(value)
                ? Number(value)
                : NaN;
          if (Number.isSafeInteger(count) && count >= 0 && evidence[key] === undefined) {
            evidence[key] = count;
            markEvidence(key, "public_metadata", "X public embed");
          }
        }
      } else {
        for (let redirect = 0; redirect <= 3; redirect++) {
          const response = await fetcher(targetUrl, {
            method: "GET",
            redirect: "manual",
            signal,
            headers: {
              Accept: "text/html,application/json",
              "Accept-Language": "en-US,en;q=0.9",
              "User-Agent": "Mozilla/5.0 (compatible; BentoSurfBot/1.0; +http://localhost:8080)",
            },
          });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            const redirected = location ? new URL(location, targetUrl).href : null;
            const next = redirected ? normalizePublicPostUrl(redirected) : null;
            if (
              !next ||
              next.platform !== source.platform ||
              (expectedIdentity && discoverPostKey({ sourceUrl: next.url }) !== expectedIdentity)
            )
              throw new Error("Post identity changed");
            current = next;
            if (!next.short) expectedIdentity ??= discoverPostKey({ sourceUrl: next.url });
            // Validate using canonical identity, but follow the server's actual www/trailing-slash
            // target. Re-canonicalizing the fetch URL here would create a redirect loop.
            targetUrl = redirected!;
            continue;
          }
          if (
            !response.ok ||
            !/^(text\/html|application\/(?:ld\+)?json)/i.test(
              response.headers.get("content-type") || "",
            )
          ) {
            await response.body?.cancel();
            throw new Error("Public post unavailable");
          }
          const html = await readPublicPostPrefix(response);
          const metadata = publicPostMetadata(html.slice(0, 1_500_000), current.url);
          if (source.platform === "Instagram" && metadata.authorUrl) {
            const handle = new URL(metadata.authorUrl).pathname.replace(/^\/|\/$/g, "");
            if (/^[A-Za-z0-9._]{1,30}$/.test(handle)) authorHandle ??= handle;
          }
          for (const [key, value] of Object.entries(publicPostCountEvidence(html, current.url))) {
            const metric = key as PublicPostMetric;
            if (evidence[metric] === undefined && value !== undefined) {
              evidence[metric] = value;
              markEvidence(metric, "public_metadata", "Public post page");
            }
          }
          break;
        }
      }
    } catch {
      /* Keep any successful extractor counters when a public supplement fails. */
    }
  }
  // Public Instagram embeds can return a placeholder zero for hidden likes.
  // Preserve a real zero only when an official API verifies it.
  if (
    source.platform === "Instagram" &&
    extractionMethod === "instagram-download-metadata" &&
    evidence.likes === 0
  ) {
    delete evidence.likes;
    delete metricEvidence.likes;
    unverified.add("likes");
  }
  if (
    !deps.suppressRendered &&
    (env.BROWSER || deps.rendered) &&
    platformPostMetrics[source.platform].some(
      (key) => evidence[key] === undefined && key !== "saves",
    )
  ) {
    try {
      const rendered: Awaited<ReturnType<NonNullable<Dependencies["rendered"]>>> = deps.rendered
        ? await deps.rendered(current.url)
        : ["Instagram", "Facebook", "Threads", "Reddit"].includes(source.platform)
          ? await (
              await import("./public-post-browser.server")
            ).readRenderedPublicPostStats(
              current.url,
              platformPostMetrics[source.platform].filter(
                (key) => evidence[key] === undefined && key !== "saves",
              ),
            )
          : {
              ...(await (
                await import("./social-preview-reliability.server")
              ).fetchRenderedSocialHtml(current.url)),
              counts: undefined,
              precision: undefined,
            };
      const renderedCounts =
        rendered.counts ?? publicPostCountEvidence(rendered.value, current.url);
      for (const key of rendered.requiresSignIn || []) signInRequired.add(key);
      for (const [key, value] of Object.entries(renderedCounts)) {
        const metric = key as PublicPostMetric;
        if (
          evidence[metric] !== undefined ||
          value === undefined ||
          (source.platform === "Instagram" && metric === "likes" && value === 0)
        )
          continue;
        evidence[metric] = value;
        markEvidence(metric, "rendered_page", "Rendered public post");
        if (rendered.precision?.[metric])
          metricEvidence[metric]!.precision = rendered.precision[metric]!;
        unverified.delete(metric);
      }
    } catch {
      /* One budgeted browser attempt; no proxy, login or retry. */
    }
  }
  const accessNotes: string[] = [];
  if (signInRequired.size)
    accessNotes.push(
      `${source.platform}'s page requested a platform sign-in for the additional counters. Only signed-out counts are included.`,
    );
  let managedPending = false;
  if (managed) {
    const supplement =
      resumed && resumed.status !== "unconfigured"
        ? resumed
        : await managed(
            current.url,
            platformPostMetrics[source.platform].filter(
              (key) => evidence[key] === undefined && key !== "saves",
            ),
            managedOptions,
          );
    applyManaged(supplement);
    managedPending = supplement.status === "pending";
    if (managedPending)
      accessNotes.push(
        "Remaining public counters are still being retrieved. Check this link again in 15 seconds; the existing collection will be reused.",
      );
    if (supplement.status === "limited")
      accessNotes.push(
        "The extra public-data retrieval allowance is currently exhausted. Available free-source counters are shown.",
      );
  }
  const metrics = platformPostMetrics[source.platform].map((key) => ({
    key,
    label:
      source.platform === "LinkedIn" && key === "likes"
        ? "Reactions"
        : source.platform === "X" && key === "saves"
          ? "Bookmarks"
          : ["X", "Threads"].includes(source.platform) && key === "comments"
            ? "Replies"
            : publicPostMetricLabels[key],
    value: evidence[key] ?? null,
    evidence: metricEvidence[key],
    availability: (evidence[key] !== undefined
      ? "observed"
      : unverified.has(key)
        ? "unverified"
        : source.platform === "Instagram" && key === "saves"
          ? "not_public"
          : signInRequired.has(key)
            ? "requires_sign_in"
            : extractionError
              ? "failed"
              : "not_returned") as NonNullable<PublicPostStats["metrics"][number]["availability"]>,
  }));
  const observed = metrics.filter((m) => m.value !== null).length;
  if (
    !observed &&
    extractionError &&
    !deps.allowUnavailable &&
    !managedPending &&
    !signInRequired.size
  )
    throw new RequestHttpError(
      extractionError.status,
      "The extraction service could not retrieve this public post. Try again shortly or check that the link is public.",
    );
  const result: PublicPostStats = {
    platform: source.platform,
    sourceUrl: current.url,
    retrievedAt: new Date().toISOString(),
    cached: false,
    extractionMethod,
    scope: "public",
    authorHandle,
    ...(accessNotes.length ? { accessNotes } : {}),
    ...(resolvedFromRepost ? { requestedUrl: source.url } : {}),
    status: observed === metrics.length ? "available" : observed ? "partial" : "unavailable",
    metrics,
    note: managedPending
      ? "Retrieving the remaining public counters. Any counts already shown are from completed sources; pending counts are not zero."
      : !observed
        ? "This platform did not expose readable public counts for this post. It may require sign-in, hide counts or restrict automated access. Unavailable does not mean zero."
        : `${resolvedFromRepost ? "This link is a repost; these are the original post’s public counters. " : ""}Counters identify their source and observation time; public displays may be rounded. Missing values are not zero.${unverified.size ? " Unverified likes are withheld because Instagram embeds can return a placeholder zero." : ""} Owner-only analytics require authorized account access.`,
  };
  try {
    await cache?.put(
      cacheKey,
      Response.json(result, {
        headers: {
          "cache-control": `public, max-age=${managedPending ? 15 : observed ? 300 : 60}`,
        },
      }),
    );
  } catch {
    /* Optional shared cache. */
  }
  return result;
}

export async function handlePublicPostStatsRequest(
  request: Request,
  env: PublicPostStatsEnv,
  deps: Dependencies = {},
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PUBLIC_POST_STATS_PATH) return null;
  const headers = { "cache-control": "private, no-store" };
  const error = (message: string, status: number) =>
    Response.json(
      { error: message },
      { status, headers: { ...headers, ...(status === 429 ? { "retry-after": "60" } : {}) } },
    );
  if (request.method !== "POST")
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { ...headers, allow: "POST" } },
    );
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return error("Cross-origin requests are not allowed.", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    return error("Send the post link as JSON.", 415);
  try {
    let value: unknown;
    try {
      value = JSON.parse(await readRequestText(request, 4_096));
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) throw e;
      throw new RequestHttpError(400, "Enter a valid post link.");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => k !== "url") ||
      !("url" in value) ||
      !normalizePublicPostUrl(value.url)
    )
      throw new RequestHttpError(400, "Enter a supported public post or video link.");
    const limiter = env.FREE_TOOLS_MEDIA_RATE_LIMITER;
    if (!limiter) throw new RequestHttpError(503, "Public stats are temporarily unavailable.");
    const key = deps.trustedMcpWorkspaceId
      ? `public-stats:workspace:${deps.trustedMcpWorkspaceId}`
      : `public-stats:ip:${request.headers.get("cf-connecting-ip") || "unknown"}`;
    if (!(await limiter.limit({ key })).success)
      throw new RequestHttpError(429, "Too many requests. Please wait a minute.");
    if (!deps.trustedMcpWorkspaceId) await enforceTurnstileRequest(request, env);
    const result =
      deps.useConnectedAccounts && deps.trustedMcpWorkspaceId
        ? await (
            await import("./post-stats-connected.server")
          ).readWorkspacePostStats(String(value.url), deps.trustedMcpWorkspaceId)
        : await readPublicPostStats(String(value.url), { ...deps, env });
    return Response.json(result, {
      headers,
    });
  } catch (e) {
    if (e instanceof RequestBodyTooLargeError) return error("The request is too large.", 413);
    if (e instanceof ProviderBudgetError) return error(e.message, 429);
    if (e instanceof RequestHttpError) return error(e.message, e.statusCode);
    return error("Public stats are temporarily unavailable.", 503);
  }
}
