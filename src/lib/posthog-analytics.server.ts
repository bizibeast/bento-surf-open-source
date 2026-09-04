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
};

type ResolvedQueryConfig = Required<Pick<QueryConfig, "apiKey" | "host" | "projectId" | "fetcher">>;

const DAY_MS = 86_400_000;
const CACHE_MS = 55_000;
const analyticsCache = new Map<
  string,
  { expiresAt: number; value: Promise<FounderWebAnalytics> }
>();

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
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today.getTime() - (offset + days - index - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    return byDate.get(date) ?? { date, visitors: 0, conversions: 0 };
  });
}

function appHost(value: string | undefined) {
  const trimmed = value?.trim();
  return (trimmed || "https://us.posthog.com")
    .replace(".i.posthog.com", ".posthog.com")
    .replace(/\/$/, "");
}

async function runHogQL(query: string, config: ResolvedQueryConfig) {
  try {
    const response = await config.fetcher(
      `${config.host}/api/projects/${config.projectId}/query/`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      },
    );
    if (!response.ok) throw new Error(`PostHog query failed (${response.status})`);
    const payload = (await response.json()) as HogQLResponse;
    if (payload.error) throw new Error(payload.error);
    return payload.results ?? [];
  } catch (error) {
    console.warn("[posthog] analytics panel unavailable", error);
    return [];
  }
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
  return `SELECT ${expression} AS ${alias},
      uniqIf(distinct_id, event = '$pageview'),
      uniqIf(distinct_id, event = 'onboarding_completed'),
      0
    FROM events
    WHERE timestamp >= ${currentStart} AND timestamp < ${currentEnd} AND ${eventFilter}
    GROUP BY ${alias}
    ORDER BY uniqIf(distinct_id, event = '$pageview') DESC
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
  config: ResolvedQueryConfig,
): Promise<FounderWebAnalytics> {
  const currentStart = `now() - INTERVAL ${days + offset} DAY`;
  const currentEnd = `now() - INTERVAL ${offset} DAY`;
  const previousStart = `now() - INTERVAL ${days * 2 + offset} DAY`;
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
    runHogQL(breakdownQuery(channel, "channel", currentStart, currentEnd), config),
    runHogQL(breakdownQuery(referrer, "referrer", currentStart, currentEnd), config),
    runHogQL(breakdownQuery(campaign, "campaign", currentStart, currentEnd), config),
    runHogQL(breakdownQuery(keyword, "keyword", currentStart, currentEnd), config),
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.$geoip_country_name), ''), 'Unknown')`,
        "country",
        currentStart,
        currentEnd,
      ),
      config,
    ),
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.$geoip_subdivision_1_name), ''), 'Unknown')`,
        "region",
        currentStart,
        currentEnd,
      ),
      config,
    ),
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.$geoip_city_name), ''), 'Unknown')`,
        "city",
        currentStart,
        currentEnd,
      ),
      config,
    ),
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.$host), ''), 'bento.surf')`,
        "hostname",
        currentStart,
        currentEnd,
      ),
      config,
    ),
    runHogQL(breakdownQuery(path, "page", currentStart, currentEnd), config),
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
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.$browser), ''), 'Unknown')`,
        "browser",
        currentStart,
        currentEnd,
      ),
      config,
    ),
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.$os), ''), 'Unknown')`,
        "operating_system",
        currentStart,
        currentEnd,
      ),
      config,
    ),
    runHogQL(
      breakdownQuery(
        `coalesce(nullIf(toString(properties.$device_type), ''), 'Unknown')`,
        "device",
        currentStart,
        currentEnd,
      ),
      config,
    ),
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
  ] = results;
  const overview = overviewRows[0] ?? [];
  const sessions = sessionRows[0] ?? [];

  return {
    available: overviewRows.length > 0,
    error: overviewRows.length ? null : "PostHog overview query is unavailable.",
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
  const projectId = overrides.projectId?.trim() || process.env.POSTHOG_PROJECT_ID?.trim();
  const host = appHost(overrides.host ?? process.env.POSTHOG_HOST);
  // Cloudflare Workers' global fetch is an "illegal invocation" when it is
  // detached from globalThis and later called as an object method. Bind the
  // runtime fetch once while keeping injected test fetchers untouched.
  const fetcher = overrides.fetcher ?? globalThis.fetch.bind(globalThis);
  if (!apiKey || !projectId)
    return emptyAnalytics(days, "PostHog reporting is not configured.", offset);

  const config = { apiKey, projectId, host, fetcher };
  const cacheable = Object.keys(overrides).length === 0;
  if (cacheable) {
    const cached = analyticsCache.get(`${days}:${offset}`);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const value = loadFounderWebAnalytics(days, offset, config).catch((error) => {
    console.warn("[posthog] founder analytics unavailable", error);
    return emptyAnalytics(days, "PostHog reporting is temporarily unavailable.", offset);
  });
  if (cacheable)
    analyticsCache.set(`${days}:${offset}`, { expiresAt: Date.now() + CACHE_MS, value });
  return value;
}
