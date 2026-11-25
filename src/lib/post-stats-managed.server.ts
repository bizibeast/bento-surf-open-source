import { discoverPostKey } from "./content-discover-identity";
import { observedCount } from "./content-source-enrichment";
import {
  normalizePublicPostUrl,
  type PublicPostMetric,
  type PublicPostPlatform,
} from "./public-post-stats";
import { hasManagedProviderBudget, reserveProviderUsage } from "./provider-budget.server";
import { readResponseText } from "./request-security.server";

type Counts = Partial<Record<PublicPostMetric, number>>;
type CacheStore = Pick<Cache, "match" | "put">;
type Options = {
  enabled: boolean;
  apiKey?: string;
  cache?: CacheStore | null;
  workspaceId?: string;
  fetcher?: typeof fetch;
  reserve?: typeof reserveProviderUsage;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  pollLimit?: 1 | 2 | 3;
  onlyExisting?: boolean;
};
type Result = {
  status: "unconfigured" | "limited" | "pending" | "available" | "unavailable";
  counts: Counts;
  observedAt?: string;
};
type Job = {
  sourceUrl: string;
  datasetId: string;
  startedAt: string;
  state: "submitting" | "pending" | "ready" | "failed";
  snapshotId?: string;
  counts?: Counts;
  observedAt?: string;
};

// Official collect_by_url schemas, reviewed 2026-11-24:
// https://docs.brightdata.com/scrapers.json and /scrapers/{dataset_id}.json.
// Every submission is one exact post URL, one record, and never discovery.
const sources: Partial<
  Record<
    PublicPostPlatform,
    {
      id: string;
      fields: string;
      metrics: readonly PublicPostMetric[];
    }
  >
> = {
  Facebook: {
    id: "gd_lyclm1571iy3mv57zw",
    fields: "url|post_id|likes|num_comments|num_shares|video_view_count|play_count",
    metrics: ["views", "likes", "comments", "shares"],
  },
  Reddit: {
    id: "gd_lvz8ah06191smkebj4",
    fields: "url|post_id|num_upvotes|num_comments",
    metrics: ["score", "comments"],
  },
  Threads: {
    id: "gd_md75myxy14rihbjksa",
    fields:
      "url|post_id|number_of_likes|number_of_comments|number_of_reshares|number_of_shares|views",
    metrics: ["views", "likes", "comments", "shares", "reshares"],
  },
  Instagram: {
    id: "gd_lk5ns7kz21pck8jpis",
    fields: "url|post_id|shortcode|likes|num_comments|video_view_count|video_play_count",
    metrics: ["views", "likes", "comments"],
  },
  LinkedIn: {
    id: "gd_lyy3tktm25m4avu764",
    fields: "url|id|num_likes|num_comments",
    metrics: ["likes", "comments"],
  },
};

export function parseManagedPublicPostStats(sourceUrl: string, payload: unknown): Counts {
  const source = normalizePublicPostUrl(sourceUrl);
  if (!source || !Array.isArray(payload) || payload.length !== 1) return {};
  const row = payload[0];
  if (!row || typeof row !== "object" || row.error || row.error_code) return {};
  const actual = normalizePublicPostUrl(row.url);
  if (
    !actual ||
    actual.platform !== source.platform ||
    discoverPostKey({ sourceUrl: actual.url }) !== discoverPostKey({ sourceUrl: source.url })
  )
    return {};
  const expected = discoverPostKey({ sourceUrl: source.url }).split(":").at(-1);
  if (
    source.platform === "Reddit" &&
    row.post_id !== undefined &&
    String(row.post_id).replace(/^t3_/, "") !== expected
  )
    return {};
  if (source.platform === "Instagram" && row.shortcode !== undefined && row.shortcode !== expected)
    return {};
  const values: Partial<Record<PublicPostMetric, unknown>> =
    source.platform === "Facebook"
      ? {
          views: row.play_count ?? row.video_view_count,
          likes: row.likes,
          comments: row.num_comments,
          shares: row.num_shares,
        }
      : source.platform === "Reddit"
        ? { score: row.num_upvotes, comments: row.num_comments }
        : source.platform === "Threads"
          ? {
              views: row.views,
              likes: row.number_of_likes,
              comments: row.number_of_comments,
              shares: row.number_of_shares,
              reshares: row.number_of_reshares,
            }
          : source.platform === "Instagram"
            ? {
                views: row.video_play_count ?? row.video_view_count,
                likes: row.likes,
                comments: row.num_comments,
              }
            : source.platform === "LinkedIn"
              ? { likes: row.num_likes, comments: row.num_comments }
              : {};
  const counts: Counts = {};
  for (const [key, value] of Object.entries(values)) {
    const n = observedCount(value);
    if (n !== null && !(source.platform === "Instagram" && key === "likes" && n === 0))
      counts[key as PublicPostMetric] = n;
  }
  return counts;
}

const inFlight = new Map<string, Promise<Result>>();

export async function readManagedPublicPostStats(
  sourceUrl: string,
  missing: readonly PublicPostMetric[],
  options: Options,
): Promise<Result> {
  const source = normalizePublicPostUrl(sourceUrl);
  const provider = source && sources[source.platform];
  const empty = (status: Result["status"]): Result => ({ status, counts: {} });
  if (
    !options.enabled ||
    !options.apiKey ||
    !source ||
    source.short ||
    !provider ||
    !provider.metrics.some((key) => missing.includes(key))
  )
    return empty("unconfigured");
  // Fail closed rather than create a paid job whose ID cannot survive a request.
  if (!options.cache) return empty("unavailable");
  if (options.signal?.aborted) return empty("unavailable");
  const cache = options.cache;
  const identity = source.url;
  const prior = inFlight.get(identity);
  if (prior) return prior;
  const work = async (): Promise<Result> => {
    const cacheKey = new Request(
      `https://instance.invalid/__cache/post-stats-managed/v1/${encodeURIComponent(identity)}`,
    );
    const save = async (job: Job) =>
      cache.put(
        cacheKey,
        Response.json(job, {
          headers: {
            "cache-control": `public, max-age=${job.state === "ready" || job.state === "failed" ? 300 : 900}`,
          },
        }),
      );
    const fetcher = options.fetcher ?? fetch;
    const signal = AbortSignal.any([
      options.signal ?? AbortSignal.timeout(20_000),
      AbortSignal.timeout(20_000),
    ]);
    const headers = {
      Authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    };
    let job: Job | undefined;
    let phase = "cache";
    let responseStatus: number | undefined;
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const saved = (await hit.json()) as Job;
        if (
          saved.sourceUrl === identity &&
          saved.datasetId === provider.id &&
          Number.isFinite(Date.parse(saved.startedAt))
        )
          job = saved;
      }
      if (job?.state === "ready")
        return {
          status: "available",
          counts: job.counts ?? {},
          observedAt: job.observedAt ?? job.startedAt,
        };
      if (job?.state === "failed") return empty("unavailable");
      if (job?.state === "submitting") return empty("pending");
      if (!job) {
        if (options.onlyExisting) return empty("unconfigured");
        try {
          await (options.reserve ?? reserveProviderUsage)("bright_data_requests", 1, {
            workspaceId: options.workspaceId,
            ...(hasManagedProviderBudget() ? { managedCostMicrousd: 1500 } : {}),
          });
        } catch {
          return empty("limited");
        }
        job = {
          sourceUrl: identity,
          datasetId: provider.id,
          state: "submitting",
          startedAt: new Date().toISOString(),
        };
        await save(job);
        const endpoint = new URL("https://api.brightdata.com/datasets/v3/trigger");
        endpoint.searchParams.set("dataset_id", provider.id);
        endpoint.searchParams.set("include_errors", "true");
        endpoint.searchParams.set("custom_output_fields", provider.fields);
        phase = "submit";
        const response = await fetcher(endpoint, {
          method: "POST",
          headers,
          redirect: "manual",
          signal,
          body: JSON.stringify({
            input: [{ url: identity }],
            limit_per_input: 1,
            custom_output_fields: provider.fields,
          }),
        });
        responseStatus = response.status;
        const payload = JSON.parse(await readResponseText(response, 16_384)) as {
          snapshot_id?: string;
        };
        if (!response.ok || !/^sd_[A-Za-z0-9_-]{1,100}$/.test(payload.snapshot_id ?? "")) {
          console.warn("Managed public post collection unavailable", {
            platform: source.platform,
            phase: "submit",
            status: response.status,
          });
          await save({ ...job, state: "failed" });
          return empty("unavailable");
        }
        job = { ...job, state: "pending", snapshotId: payload.snapshot_id };
        await save(job);
      }
      if (!/^sd_[A-Za-z0-9_-]{1,100}$/.test(job.snapshotId ?? "")) return empty("unavailable");
      if (Date.now() - Date.parse(job.startedAt) > 30_000) {
        phase = "progress";
        const response = await fetcher(
          `https://api.brightdata.com/datasets/v3/progress/${job.snapshotId}`,
          { headers, redirect: "manual", signal },
        );
        responseStatus = response.status;
        const progress = JSON.parse(await readResponseText(response, 8_192)) as { status?: string };
        if (!response.ok || ["failed", "canceled", "cancelled"].includes(progress.status ?? "")) {
          console.warn("Managed public post collection unavailable", {
            platform: source.platform,
            phase: "progress",
            status: response.status,
          });
          await save({ ...job, state: "failed" });
          return empty("unavailable");
        }
      }
      const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      for (let poll = 0; poll < Math.min(3, options.pollLimit ?? 3); poll++) {
        if (signal.aborted) return empty("pending");
        await sleep(2_000);
        phase = "snapshot";
        const response = await fetcher(
          `https://api.brightdata.com/datasets/v3/snapshot/${job.snapshotId}?format=json`,
          { headers, redirect: "manual", signal },
        );
        responseStatus = response.status;
        const payload = JSON.parse(await readResponseText(response, 512_000));
        if (
          response.status === 202 ||
          payload?.status === "running" ||
          payload?.status === "building"
        )
          continue;
        const counts = response.ok ? parseManagedPublicPostStats(identity, payload) : {};
        const observedAt = new Date().toISOString();
        if (!Object.keys(counts).length)
          console.warn("Managed public post collection unavailable", {
            platform: source.platform,
            phase: "result",
            status: response.status,
          });
        await save({
          ...job,
          state: Object.keys(counts).length ? "ready" : "failed",
          counts,
          observedAt,
        });
        return {
          status: Object.keys(counts).length ? "available" : "unavailable",
          counts,
          observedAt,
        };
      }
      return empty("pending");
    } catch (error) {
      console.warn("Managed public post transport incomplete", {
        platform: source.platform,
        phase,
        status: responseStatus,
        errorType: error instanceof Error ? error.name : "Unknown",
      });
      // No retry or credit recharge. A persisted submission marker prevents a
      // transport failure from immediately creating another billable collection.
      return empty(job?.state === "pending" ? "pending" : "unavailable");
    }
  };
  const promise = work();
  inFlight.set(identity, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(identity);
  }
}
