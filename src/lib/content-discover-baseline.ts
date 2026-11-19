import { z } from "zod";
import { discoverPostKey } from "./content-discover-identity";
import { normalizeDiscoverCreator } from "./content-discover-creators";
import { sourceCreator, sourcePostEmbed } from "./content-source-media";
import type { ContentSourceItem } from "./content-sources.server";

const DAY = 86_400_000;
const MIN_PEERS = 5;
const MAX_PEERS = 50;
export const DISCOVER_BASELINE_LOOKBACK_MS = 90 * DAY;
const METRICS = ["views", "likes", "comments", "shares", "saves"] as const;
const AGE_WINDOWS = [1, 3, 7, 14, 30];
const formats = ["text", "image", "video", "carousel", "article", "reel", "short"] as const;

export const discoverBaselineSchema = z.object({
  metric: z.enum(METRICS),
  format: z.enum(formats),
  creatorUrl: z.string(),
  sampleSize: z.number().int().min(MIN_PEERS).max(MAX_PEERS),
  median: z.number().positive(),
  observed: z.number().nonnegative(),
  ratio: z.number().nonnegative(),
  ageWindow: z.object({
    minDays: z.number().int().nonnegative().lt(30),
    maxDays: z.number().int().positive().max(30),
  }),
  sampleFrom: z.iso.datetime({ offset: true }),
  sampleThrough: z.iso.datetime({ offset: true }),
});
export type DiscoverBaseline = z.infer<typeof discoverBaselineSchema>;

export function observedDiscoverMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export type DiscoverMetricObservation = Pick<
  ContentSourceItem,
  | "canonicalUrl"
  | "publishedAt"
  | "retrievedAt"
  | "platform"
  | "kind"
  | "authorUrl"
  | "mediaType"
  | "stats"
>;

function observation(source: DiscoverMetricObservation, now: number) {
  const published = Date.parse(source.publishedAt || "");
  const retrieved = Date.parse(source.retrievedAt);
  const age = retrieved - published;
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    retrieved > now + 60_000 ||
    published < now - DISCOVER_BASELINE_LOOKBACK_MS
  )
    return null;

  const ageBucket = AGE_WINDOWS.findIndex((limit) => age <= limit * DAY);
  if (ageBucket < 0) return null;

  const fallback = sourceCreator(source.canonicalUrl);
  const authorUrl = source.authorUrl || fallback?.url;
  if (!authorUrl) return null;
  let creator;
  try {
    creator = normalizeDiscoverCreator(authorUrl);
  } catch {
    return null;
  }

  const declaredPlatform = (source.platform || source.kind).toLowerCase().replace("twitter", "x");
  if (declaredPlatform !== creator.platform.toLowerCase()) return null;

  const embed = sourcePostEmbed(source.canonicalUrl);
  const format: DiscoverBaseline["format"] | null =
    embed?.label === "Reel"
      ? "reel"
      : creator.platform === "YouTube" && /\/shorts\//.test(source.canonicalUrl)
        ? "short"
        : source.mediaType || (creator.platform === "YouTube" ? "video" : null);
  if (!format) return null;

  const sourceId = discoverPostKey(source);
  if (!sourceId) return null;
  const creatorKey = creator.profileUrl.includes("/channel/")
    ? creator.profileUrl
    : creator.profileUrl.toLowerCase();
  return {
    sourceId,
    source,
    published,
    retrieved,
    format,
    creatorUrl: creator.profileUrl,
    group: JSON.stringify([creatorKey, format, ageBucket]),
    ageWindow: { minDays: AGE_WINDOWS[ageBucket - 1] || 0, maxDays: AGE_WINDOWS[ageBucket] },
  };
}

/** Age-matched prior posts from the same measured creator and format, using cached data only. */
export function measureDiscoverBaselines(
  targets: ContentSourceItem[],
  cachedSources: DiscoverMetricObservation[],
  now = Date.now(),
): Map<string, DiscoverBaseline> {
  const groups = new Map<string, Map<string, NonNullable<ReturnType<typeof observation>>>>();
  for (const source of cachedSources) {
    const sample = observation(source, now);
    if (!sample) continue;
    const group = groups.get(sample.group) || new Map();
    const previous = group.get(sample.sourceId);
    if (!previous || sample.retrieved > previous.retrieved) group.set(sample.sourceId, sample);
    groups.set(sample.group, group);
  }

  const baselines = new Map<string, DiscoverBaseline>();
  for (const source of targets) {
    const target = observation(source, now);
    if (!target) continue;
    const group = groups.get(target.group);
    if (!group || group.size < MIN_PEERS) continue;
    const prior = [...group.values()]
      .filter(
        (sample) => sample.sourceId !== target.sourceId && sample.published < target.published,
      )
      .sort((a, b) => b.published - a.published || a.sourceId.localeCompare(b.sourceId))
      .slice(0, MAX_PEERS);
    if (prior.length < MIN_PEERS) continue;

    for (const metric of METRICS) {
      const observed = observedDiscoverMetric(source.stats?.[metric]);
      if (observed === null) continue;
      const samples = prior.flatMap((sample) => {
        const value = observedDiscoverMetric(sample.source.stats?.[metric]);
        return value === null ? [] : [{ value, published: sample.published }];
      });
      if (samples.length < MIN_PEERS) continue;
      const values = samples.map((sample) => sample.value).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      const median =
        values.length % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2;
      const ratio = observed / median;
      if (!Number.isFinite(ratio)) continue;
      baselines.set(target.sourceId, {
        metric,
        format: target.format,
        creatorUrl: target.creatorUrl,
        sampleSize: samples.length,
        median,
        observed,
        ratio,
        ageWindow: target.ageWindow,
        sampleFrom: new Date(samples[samples.length - 1].published).toISOString(),
        sampleThrough: new Date(samples[0].published).toISOString(),
      });
      break;
    }
  }
  return baselines;
}
