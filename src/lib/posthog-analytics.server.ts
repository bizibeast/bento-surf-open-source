import { founderPeriod } from "./founder-period";

export type AnalyticsBreakdown = {
  label: string;
  visitors: number;
  conversions: number;
  revenue: number;
};

export type AnalyticsJourney = {
  distinctId: string;
  source: string;
  country: string;
  device: string;
  operatingSystem: string;
  browser: string;
  firstSeenAt: string | null;
  completedAt: string | null;
  timeToCompleteSeconds: number;
};

export type CrawlerBreakdown = {
  label: string;
  visits: number;
  share: number;
};

export type FounderWebAnalytics = {
  available: boolean;
  unavailablePanels: string[];
  error: string | null;
  days: 7 | 30 | 90;
  offset: number;
  overview: {
    pageviews: number;
    visitors: number;
    conversions: number;
    online: number;
    previousPageviews: number;
    previousVisitors: number;
    previousConversions: number;
    bounceRate: number;
    averageSessionSeconds: number;
  };
  daily: Array<{ date: string; visitors: number; conversions: number }>;
  acquisition: {
    channels: AnalyticsBreakdown[];
    referrers: AnalyticsBreakdown[];
    campaigns: AnalyticsBreakdown[];
    keywords: AnalyticsBreakdown[];
  };
  geography: {
    countries: AnalyticsBreakdown[];
    regions: AnalyticsBreakdown[];
    cities: AnalyticsBreakdown[];
  };
  content: {
    hostnames: AnalyticsBreakdown[];
    pages: AnalyticsBreakdown[];
    entryPages: AnalyticsBreakdown[];
    exitLinks: AnalyticsBreakdown[];
  };
  technology: {
    browsers: AnalyticsBreakdown[];
    operatingSystems: AnalyticsBreakdown[];
    devices: AnalyticsBreakdown[];
  };
  journeys: AnalyticsJourney[];
  crawlers: {
    aiAnswers: CrawlerBreakdown[];
    indexing: CrawlerBreakdown[];
    training: CrawlerBreakdown[];
  };
};

type HogQLResponse = {
  results?: unknown[][];
  error?: string | null;
};

type QueryConfig = {
  apiKey?: string;
  host?: string;
  projectId?: string;
  fetcher?: typeof fetch;
  environment?: "production" | "staging";
  report?: "all" | "audience" | "journeys";
  /** Bypass a settled snapshot. An in-flight load is still not joined. */
  fresh?: boolean;
};

type QueryRuntime = Required<
  Pick<QueryConfig, "apiKey" | "host" | "projectId" | "fetcher" | "environment" | "report">
>;

type ResolvedQueryConfig = QueryRuntime & {
  limit: <T>(work: () => Promise<T>) => Promise<T>;
  deadline: AbortSignal;
};

const PANEL_NAMES = [
  "overview",
  "sessions",
  "daily",
  "channels",
  "referrers",
  "campaigns",
  "keywords",
  "countries",
  "regions",
  "cities",
  "hostnames",
  "pages",
  "entryPages",
  "exitLinks",
  "browsers",
  "operatingSystems",
  "devices",
  "journeys",
  "crawlers",
] as const;
const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 2 * 60_000;
const ATTEMPT_GAP_MS = 60_000;
// Settled snapshots only. A shared in-flight promise is resolved from whichever
// request finishes it, which Cloudflare rejects as a cross-request promise.
const analyticsCache = new Map<string, { expiresAt: number; value: FounderWebAnalytics }>();
const analyticsInFlight = new Map<string, number>();

export function clearFounderAnalyticsCache() {
  analyticsCache.clear();
  analyticsInFlight.clear();
}

function emptyBreakdowns() {
  return {
    acquisition: { channels: [], referrers: [], campaigns: [], keywords: [] },
    geography: { countries: [], regions: [], cities: [] },
    content: { hostnames: [], pages: [], entryPages: [], exitLinks: [] },
    technology: { browsers: [], operatingSystems: [], devices: [] },
  };
}

function emptyAnalytics(days: 7 | 30 | 90, error: string | null, offset = 0): FounderWebAnalytics {
  return {
    available: false,
    unavailablePanels: [...PANEL_NAMES],
    error,
    days,
    offset,
    overview: {
      pageviews: 0,
      visitors: 0,
      conversions: 0,
      online: 0,
      previousPageviews: 0,
      previousVisitors: 0,
      previousConversions: 0,
      bounceRate: 0,
      averageSessionSeconds: 0,
    },
    daily: fillDaily(days, [], offset),
    ...emptyBreakdowns(),
    journeys: [],
    crawlers: { aiAnswers: [], indexing: [], training: [] },
  };
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function label(value: unknown, fallback = "Unknown"): string {
  const result = typeof value === "string" ? value.trim() : "";
  return result || fallback;
}

function nullableLabel(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}

function fillDaily(
  days: 7 | 30 | 90,
  rows: Array<{ date: string; visitors: number; conversions: number }>,
  offset = 0,
) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  return founderPeriod(days, offset).dates.map(
    (date) => byDate.get(date) ?? { date, visitors: 0, conversions: 0 },
  );
}

function appHost(value: string | undefined) {
  const trimmed = value?.trim();
  return (trimmed || "https://us.posthog.com")
    .replace(".i.posthog.com", ".posthog.com")
    .replace(/\/$/, "");
}

const POSTHOG_TIMEOUT_MS = 8_000;
const POSTHOG_BUDGET_MS = 12_000;
const MAX_CONCURRENT_QUERIES = 4;

function createQueryLimiter(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function limit<T>(work: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiters.push(resolve));
    else active += 1;
    try {
      return await work();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function queryCategory(query: string) {
  if (query.includes("arrayJoin([")) return "breakdowns";
  if (query.includes("countIf(event = '$pageview' AND timestamp")) return "overview";
  if (query.includes("avg(duration_seconds)")) return "sessions";
  if (query.includes("toDate(timestamp)")) return "daily";
  if (query.includes("entry_page")) return "entryPages";
  if (query.includes("AS exit_link")) return "exitLinks";
  if (query.trimStart().startsWith("SELECT distinct_id,")) return "journeys";
  return "crawlers";
}

async function runHogQL(query: string, config: ResolvedQueryConfig) {
  const panel = queryCategory(query);
  if (config.report === "journeys" && panel !== "journeys" && panel !== "overview") return [];
  if (config.report === "audience" && panel === "journeys") return [];
  // Missing JSON properties are NULL in HogQL: empty(toString(NULL)) is still
  // NULL. Coalesce before comparing so untagged legacy events count as production.
  // Self-hosted instances have no hosted staging hostnames to fall back on.
  const legacy = "coalesce(toString(properties.deployment_environment), '') = ''";
  const environmentFilter =
    config.environment === "staging"
      ? "properties.deployment_environment = 'staging'"
      : `(properties.deployment_environment = 'production' OR ${legacy})`;
  const scopedQuery = query.replace(
    /FROM events\s+WHERE/g,
    `FROM events WHERE ${environmentFilter} AND`,
  );
  const queuedAt = Date.now();
  return config.limit(async () => {
    const startedAt = Date.now();
    let status: number | null = null;
    let reason = "network";
    try {
      const response = await config.fetcher(
        `${config.host}/api/projects/${config.projectId}/query/`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
          // One analytics load owns this limiter. Do not queue another request's
          // promise here: resolving it trips Workers' cross-request warning.
          signal: AbortSignal.any([config.deadline, AbortSignal.timeout(POSTHOG_TIMEOUT_MS)]),
          body: JSON.stringify({ query: { kind: "HogQLQuery", query: scopedQuery } }),
        },
      );
      status = response.status;
      if (!response.ok) {
        reason = "http";
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Reporting HTTP error");
      }
      reason = "invalid_response";
      const payload = (await response.json()) as HogQLResponse;
      if (payload.error) {
        reason = "query";
        throw new Error("Reporting query error");
      }
      if (!Array.isArray(payload.results)) throw new Error("Missing report results");
      return payload.results;
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? error.name : null;
      if (name === "TimeoutError" || name === "AbortError") reason = "timeout";
      console.warn("[posthog] analytics panel unavailable", {
        panel,
        reason,
        status,
        durationMs: Date.now() - startedAt,
        queuedMs: startedAt - queuedAt,
      });
      return null;
    }
  });
}

function breakdown(rows: unknown[][]): AnalyticsBreakdown[] {
  return rows.map((row) => ({
    label: label(row[0], "Direct/None"),
    visitors: number(row[1]),
    conversions: number(row[2]),
    revenue: number(row[3]),
  }));
}

function breakdownQuery(
  expression: string,
  alias: string,
  currentStart: string,
  currentEnd: string,
  eventFilter = "event IN ('$pageview', 'onboarding_completed')",
) {
  const visitorEvent =
    eventFilter === "event = 'outbound_link_clicked'" ? "outbound_link_clicked" : "$pageview";
  return `SELECT ${expression} AS ${alias},
      uniqIf(distinct_id, event = '${visitorEvent}'),
      uniqIf(distinct_id, event = 'onboarding_completed'),
      0
    FROM events
    WHERE timestamp >= ${currentStart} AND timestamp < ${currentEnd} AND ${eventFilter}
    GROUP BY ${alias}
    ORDER BY uniqIf(distinct_id, event = '${visitorEvent}') DESC
    LIMIT 12`;
}

function crawlerRows(rows: unknown[][], category: string): CrawlerBreakdown[] {
  const relevant = rows.filter((row) => label(row[0], "") === category);
  const total = relevant.reduce((sum, row) => sum + number(row[2]), 0);
  return relevant.map((row) => ({
    label: label(row[1]),
    visits: number(row[2]),
    share: total ? Math.round((number(row[2]) / total) * 100) : 0,
  }));
}

async function loadFounderWebAnalytics(
  days: 7 | 30 | 90,
  offset: number,
  runtime: QueryRuntime,
): Promise<FounderWebAnalytics> {
  const config: ResolvedQueryConfig = {
    ...runtime,
    limit: createQueryLimiter(MAX_CONCURRENT_QUERIES),
    deadline: AbortSignal.timeout(POSTHOG_BUDGET_MS),
  };
  const period = founderPeriod(days, offset);
  const previous = founderPeriod(days, offset + days);
  const timestamp = (value: string) =>
    `toDateTime('${value.slice(0, 19).replace("T", " ")}', 'UTC')`;
  const currentStart = timestamp(period.start);
  const currentEnd = timestamp(period.end);
  const previousStart = timestamp(previous.start);
  const source = `if(notEmpty(toString(properties.initial_source)), toString(properties.initial_source), if(properties.$referring_domain IN ('$direct', ''), 'Direct/None', coalesce(properties.$referring_domain, 'Direct/None')))`;
  const referrer = `if(notEmpty(toString(properties.initial_referring_domain)), toString(properties.initial_referring_domain), if(properties.$referring_domain IN ('$direct', ''), 'Direct/None', coalesce(properties.$referring_domain, 'Direct/None')))`;
  const campaign = `coalesce(nullIf(toString(properties.initial_utm_campaign), ''), nullIf(toString(properties.utm_campaign), ''), 'Direct/None')`;
  const keyword = `coalesce(nullIf(toString(properties.initial_utm_term), ''), nullIf(toString(properties.utm_term), ''), 'Direct/None')`;
  const channel = `multiIf(
    lower(toString(properties.initial_utm_medium)) IN ('cpc', 'ppc', 'paid', 'paid_search'), 'Paid Search',
    lower(toString(properties.initial_utm_medium)) IN ('email', 'newsletter'), 'Email',
    lower(toString(properties.initial_utm_medium)) IN ('social', 'paid_social'), 'Social',
    lower(${source}) IN ('google', 'bing', 'duckduckgo'), 'Organic Search',
    lower(${source}) IN ('x', 'instagram', 'facebook', 'linkedin', 'youtube', 'reddit', 'tiktok'), 'Social',
    ${source} = 'Direct/None', 'Direct',
    'Referral')`;
  const path = `coalesce(nullIf(toString(properties.$pathname), ''), nullIf(toString(properties.path), ''), '/')`;

  // One event scan and HTTP request serves all twelve standard breakdowns.
  // Entry pages, outbound events and journeys retain their separate semantics.
  const bundledBreakdowns =
    config.report === "journeys"
      ? Promise.resolve([])
      : runHogQL(
          `SELECT tupleElement(dimension, 1) AS panel, tupleElement(dimension, 2) AS label,
      uniqIf(distinct_id, event = '$pageview') AS visitors,
      uniqIf(distinct_id, event = 'onboarding_completed') AS conversions, 0 AS revenue
    FROM (
      SELECT event, distinct_id, arrayJoin([
      tuple('channel', ${channel}),
      tuple('referrer', ${referrer}),
      tuple('campaign', ${campaign}),
      tuple('keyword', ${keyword}),
      tuple('country', ${`coalesce(nullIf(toString(properties.$geoip_country_name), ''), 'Unknown')`}),
      tuple('region', ${`coalesce(nullIf(toString(properties.$geoip_subdivision_1_name), ''), 'Unknown')`}),
      tuple('city', ${`coalesce(nullIf(toString(properties.$geoip_city_name), ''), 'Unknown')`}),
      tuple('hostname', ${`coalesce(nullIf(toString(properties.$host), ''), 'unknown')`}),
      tuple('page', ${path}),
      tuple('browser', ${`coalesce(nullIf(toString(properties.$browser), ''), 'Unknown')`}),
      tuple('operating_system', ${`coalesce(nullIf(toString(properties.$os), ''), 'Unknown')`}),
      tuple('device', ${`coalesce(nullIf(toString(properties.$device_type), ''), 'Unknown')`})
      ]) AS dimension FROM events
      WHERE timestamp >= ${currentStart} AND timestamp < ${currentEnd}
        AND event IN ('$pageview', 'onboarding_completed')
    ) GROUP BY panel, label ORDER BY panel, visitors DESC LIMIT 12 BY panel`,
          config,
        );
  const breakdownReport = async (name: string) => {
    const rows = await bundledBreakdowns;
    return rows === null ? null : rows.filter((row) => row[0] === name).map((row) => row.slice(1));
  };

  const results = await Promise.all([
    runHogQL(
      `SELECT
        countIf(event = '$pageview' AND timestamp >= ${currentStart} AND timestamp < ${currentEnd}),
        uniqIf(distinct_id, event = '$pageview' AND timestamp >= ${currentStart} AND timestamp < ${currentEnd}),
        uniqIf(distinct_id, event = 'onboarding_completed' AND timestamp >= ${currentStart} AND timestamp < ${currentEnd}),
        uniqIf(distinct_id, event = '$pageview' AND timestamp >= now() - INTERVAL 5 MINUTE AND ${offset} = 0),
        countIf(event = '$pageview' AND timestamp >= ${previousStart} AND timestamp < ${currentStart}),
        uniqIf(distinct_id, event = '$pageview' AND timestamp >= ${previousStart} AND timestamp < ${currentStart}),
        uniqIf(distinct_id, event = 'onboarding_completed' AND timestamp >= ${previousStart} AND timestamp < ${currentStart})
      FROM events WHERE timestamp >= ${previousStart} AND timestamp < ${currentEnd}`,
      config,
    ),
    runHogQL(
      `SELECT round(avg(duration_seconds), 0),
        round(100 * countIf(pageviews = 1) / greatest(count(), 1), 1)
      FROM (
        SELECT properties.$session_id AS session_id,
          countIf(event = '$pageview') AS pageviews,
          dateDiff('second', min(timestamp), max(timestamp)) AS duration_seconds
        FROM events
        WHERE timestamp >= ${currentStart} AND timestamp < ${currentEnd}
          AND notEmpty(toString(properties.$session_id))
        GROUP BY session_id
      )`,
      config,
    ),
    runHogQL(
      `SELECT toDate(timestamp), uniqIf(distinct_id, event = '$pageview'),
        uniqIf(distinct_id, event = 'onboarding_completed')
      FROM events WHERE timestamp >= ${currentStart} AND timestamp < ${currentEnd}
      GROUP BY toDate(timestamp) ORDER BY toDate(timestamp)`,
      config,
    ),
    breakdownReport("channel"),
    breakdownReport("referrer"),
    breakdownReport("campaign"),
    breakdownReport("keyword"),
    breakdownReport("country"),
    breakdownReport("region"),
    breakdownReport("city"),
    breakdownReport("hostname"),
    breakdownReport("page"),
    runHogQL(
      `SELECT entry_page, uniq(visitor), 0, 0 FROM (
        SELECT distinct_id AS visitor, argMin(${path}, timestamp) AS entry_page
        FROM events
        WHERE event = '$pageview' AND timestamp >= ${currentStart} AND timestamp < ${currentEnd}
        GROUP BY visitor
      ) GROUP BY entry_page ORDER BY uniq(visitor) DESC LIMIT 12`,
      config,
    ),
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.destination_host), ''), 'Direct/None')`,
        "exit_link",
        currentStart,
        currentEnd,
        "event = 'outbound_link_clicked'",
      ),
      config,
    ),
    breakdownReport("browser"),
    breakdownReport("operating_system"),
    breakdownReport("device"),
    runHogQL(
      `SELECT distinct_id,
        argMin(${source}, timestamp),
        argMin(coalesce(nullIf(toString(properties.$geoip_country_name), ''), 'Unknown'), timestamp),
        argMin(coalesce(nullIf(toString(properties.$device_type), ''), 'Unknown'), timestamp),
        argMin(coalesce(nullIf(toString(properties.$os), ''), 'Unknown'), timestamp),
        argMin(coalesce(nullIf(toString(properties.$browser), ''), 'Unknown'), timestamp),
        minIf(timestamp, event = '$pageview'),
        minIf(timestamp, event = 'onboarding_completed'),
        dateDiff('second', minIf(timestamp, event = '$pageview'), minIf(timestamp, event = 'onboarding_completed'))
      FROM events
      WHERE timestamp >= ${currentStart} AND timestamp < ${currentEnd}
        AND event IN ('$pageview', 'onboarding_completed')
      GROUP BY distinct_id
      HAVING countIf(event = 'onboarding_completed') > 0
      ORDER BY minIf(timestamp, event = 'onboarding_completed') DESC
      LIMIT 50`,
      config,
    ),
    runHogQL(
      `SELECT coalesce(nullIf(toString(properties.crawler_category), ''), 'AI answers'),
        coalesce(nullIf(toString(properties.crawler), ''), 'Unknown'), count()
      FROM events
      WHERE event = 'ai_crawler_visit' AND timestamp >= ${currentStart} AND timestamp < ${currentEnd}
      GROUP BY properties.crawler_category, properties.crawler
      ORDER BY count() DESC`,
      config,
    ),
  ]);

  const [
    overviewRows,
    sessionRows,
    dailyRows,
    channelRows,
    referrerRows,
    campaignRows,
    keywordRows,
    countryRows,
    regionRows,
    cityRows,
    hostnameRows,
    pageRows,
    entryPageRows,
    exitLinkRows,
    browserRows,
    operatingSystemRows,
    deviceRows,
    journeyRows,
    crawlerResultRows,
  ] = results.map((rows) => rows ?? []);
  const requestedPanels =
    config.report === "journeys"
      ? ["overview", "journeys"]
      : PANEL_NAMES.filter((name) => config.report !== "audience" || name !== "journeys");
  const unavailablePanels = PANEL_NAMES.filter(
    (name, index) =>
      requestedPanels.includes(name) &&
      (results[index] === null || (name === "overview" && results[index]?.length === 0)),
  );
  const overview = overviewRows[0] ?? [];
  const sessions = sessionRows[0] ?? [];

  return {
    available: requestedPanels.some(
      (name) => !unavailablePanels.includes(name as (typeof PANEL_NAMES)[number]),
    ),
    unavailablePanels,
    error:
      unavailablePanels.length === requestedPanels.length
        ? "Product analytics is temporarily unavailable."
        : unavailablePanels.length
          ? "Some reports could not load. Available reports are shown below."
          : null,
    days,
    offset,
    overview: {
      pageviews: number(overview[0]),
      visitors: number(overview[1]),
      conversions: number(overview[2]),
      online: number(overview[3]),
      previousPageviews: number(overview[4]),
      previousVisitors: number(overview[5]),
      previousConversions: number(overview[6]),
      averageSessionSeconds: number(sessions[0]),
      bounceRate: number(sessions[1]),
    },
    daily: fillDaily(
      days,
      dailyRows.map((row) => ({
        date: label(row[0], ""),
        visitors: number(row[1]),
        conversions: number(row[2]),
      })),
      offset,
    ),
    acquisition: {
      channels: breakdown(channelRows),
      referrers: breakdown(referrerRows),
      campaigns: breakdown(campaignRows),
      keywords: breakdown(keywordRows),
    },
    geography: {
      countries: breakdown(countryRows),
      regions: breakdown(regionRows),
      cities: breakdown(cityRows),
    },
    content: {
      hostnames: breakdown(hostnameRows),
      pages: breakdown(pageRows),
      entryPages: breakdown(entryPageRows),
      exitLinks: breakdown(exitLinkRows),
    },
    technology: {
      browsers: breakdown(browserRows),
      operatingSystems: breakdown(operatingSystemRows),
      devices: breakdown(deviceRows),
    },
    journeys: journeyRows.map((row) => ({
      distinctId: label(row[0], "anonymous"),
      source: label(row[1], "Direct/None"),
      country: label(row[2]),
      device: label(row[3]),
      operatingSystem: label(row[4]),
      browser: label(row[5]),
      firstSeenAt: nullableLabel(row[6]),
      completedAt: nullableLabel(row[7]),
      timeToCompleteSeconds: number(row[8]),
    })),
    crawlers: {
      aiAnswers: crawlerRows(crawlerResultRows, "AI answers"),
      indexing: crawlerRows(crawlerResultRows, "Indexing"),
      training: crawlerRows(crawlerResultRows, "Training"),
    },
  };
}

/**
 * Aggregate, read-only acquisition data for the founder dashboard. Billing and
 * entitlement remain sourced from Supabase/Dodo, never PostHog.
 */
export async function getFounderWebAnalytics(
  days: 7 | 30 | 90,
  overrides: QueryConfig = {},
  offset = 0,
): Promise<FounderWebAnalytics> {
  const apiKey = overrides.apiKey ?? process.env.POSTHOG_QUERY_API_KEY?.trim();
  const projectId =
    overrides.projectId?.trim() || process.env.POSTHOG_PROJECT_ID?.trim() || "513770";
  const host = appHost(overrides.host ?? process.env.POSTHOG_HOST);
  // Cloudflare Workers' global fetch is an "illegal invocation" when it is
  // detached from globalThis and later called as an object method. Bind the
  // runtime fetch once while keeping injected test fetchers untouched.
  const fetcher = overrides.fetcher ?? globalThis.fetch.bind(globalThis);
  if (!apiKey) return emptyAnalytics(days, "PostHog reporting is not configured.", offset);

  const environment =
    overrides.environment ?? (process.env.APP_ENV === "staging" ? "staging" : "production");
  const report = overrides.report ?? "all";
  const runtime = { apiKey, projectId, host, fetcher, environment, report };
  // Injected fetchers are tests. Production polls share one settled snapshot.
  const useCache = overrides.fetcher === undefined;
  const cacheKey = `${environment}:${report}:${days}:${offset}`;
  if (useCache) {
    const now = Date.now();
    const cached = analyticsCache.get(cacheKey);
    if (cached && cached.expiresAt > now && !overrides.fresh) return cached.value;
    const started = analyticsInFlight.get(cacheKey) ?? 0;
    if (started && now - started < ATTEMPT_GAP_MS) {
      return (
        cached?.value ??
        emptyAnalytics(days, "Product analytics is temporarily unavailable.", offset)
      );
    }
    analyticsInFlight.set(cacheKey, now);
  }

  let value: FounderWebAnalytics;
  try {
    value = await loadFounderWebAnalytics(days, offset, runtime);
  } catch (error) {
    console.warn("[posthog] founder analytics unavailable", error);
    value = emptyAnalytics(days, "PostHog reporting is temporarily unavailable.", offset);
  } finally {
    if (useCache) analyticsInFlight.delete(cacheKey);
  }
  if (useCache) {
    analyticsCache.set(cacheKey, {
      expiresAt: Date.now() + (value.available ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS),
      value,
    });
  }
  return value;
}
