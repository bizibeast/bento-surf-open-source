import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ADMIN_ACCESS_ERROR,
  ADMIN_DATA_ERROR,
  sanitizeAdminOperationalMessage,
  summarizeAdminSubscriptions,
} from "@/lib/admin-dashboard";
import { getFounderWebAnalytics } from "@/lib/posthog-analytics.server";
import { BASE_MARKETING_CONTACTS, highestPlan, normalizePlan, type PlanId } from "@/lib/plans";
import {
  exploreCategorySchema,
  exploreReviewQueueSchema,
  isReadyForExploreReview,
  sortExploreReviewsNewestFirst,
  type ExploreCategory,
  type ExploreReviewQueue,
  type ExploreReviewStatus,
} from "@/lib/explore";
import { safePublicMediaUrl } from "@/lib/safe-url";
import { RequestHttpError } from "@/lib/request-security.server";

const DAY_MS = 86_400_000;
const uuidSchema = z.string().uuid();

type FounderDatabaseOverview = {
  totals: {
    users: number;
    onboarded: number;
    pro: number;
    free?: number;
    store?: number;
    creator?: number;
    newUsers7d: number;
    newUsersPeriod: number;
  };
  funnel: Array<{ label: string; value: number }>;
  activity: {
    creatorActive7d: number;
    creatorActive30d: number;
    pagesWithVisitors7d: number;
    pagesWithVisitors30d: number;
  };
  revenue: Array<{
    currency: string;
    gross: number;
    refunds: number;
    net: number;
    mrr: number;
  }>;
  periodRevenue: Array<{
    currency: string;
    gross: number;
    refunds: number;
    net: number;
  }>;
  dailySignups: Array<{ date: string; signups: number }>;
  dailyRevenue: Array<{ date: string; revenue: number; currency: string }>;
  recentUsers: Array<{
    id: string;
    email: string | null;
    username: string;
    displayName: string | null;
    isPro: boolean;
    onboarded: boolean;
    createdAt: string;
    lastSignInAt: string | null;
    subscriptionStatus: string | null;
    amount: number | null;
    currency: string | null;
  }>;
};

export type FounderCreatorRevenue = {
  creatorCount: number;
  totals: Array<{
    currency: string;
    creators: number;
    orders: number;
    gross: number;
    refunds: number;
    revenue: number;
    net: number;
    fees: number;
  }>;
  leaderboard: Array<{
    rank: number;
    creatorId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    currency: string;
    orders: number;
    customers: number;
    gross: number;
    refunds: number;
    revenue: number;
    net: number;
    fees: number;
    latestSaleAt: string | null;
  }>;
};

type JourneyContextRow = {
  user_id: string;
  username: string | null;
  email: string | null;
  spent: number | string;
};

type InstagramConnectionHealthRow = {
  id: string;
  connection_health: string;
  reauth_required: boolean;
  provider_error_code: string | null;
  last_verified_at: string | null;
  last_webhook_at: string | null;
};

type InstagramAutomationHealthRow = {
  id: string;
  enabled: boolean;
};

type InstagramRunHealthRow = {
  id: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
};

type FounderAddonSubscriptionRow = {
  user_id: string;
  plan_id: string;
  contact_tier_contacts: number;
  storage_addon_units: number;
};

type FounderProfilePlanRow = { id: string; plan_id: string | null; is_pro: boolean | null };
type FounderSubscribedCountRow = { creator_id: string; subscribed: number };

export function summarizeFounderAddons(
  rows: FounderAddonSubscriptionRow[],
  profiles: FounderProfilePlanRow[],
  subscribedCounts: FounderSubscribedCountRow[],
) {
  const tiers = new Map<number, number>();
  const profilePlans = new Map(
    profiles.map((profile) => [
      profile.id,
      normalizePlan(profile.plan_id, Boolean(profile.is_pro)),
    ]),
  );
  const limits = new Map<string, number>(
    profiles.map((profile) => {
      const plan = profilePlans.get(profile.id);
      return [profile.id, plan === "free" ? 0 : BASE_MARKETING_CONTACTS] as const;
    }),
  );
  let storageUnits = 0;

  for (const row of rows) {
    storageUnits += row.storage_addon_units;
    if (row.plan_id === "creator") {
      tiers.set(row.contact_tier_contacts, (tiers.get(row.contact_tier_contacts) ?? 0) + 1);
      if (profilePlans.get(row.user_id) === "creator") {
        limits.set(row.user_id, row.contact_tier_contacts);
      }
    }
  }

  return {
    contactTiers: [...tiers.entries()]
      .sort(([left], [right]) => left - right)
      .map(([contacts, creators]) => ({ contacts, creators })),
    creatorsAboveContactCapacity: subscribedCounts.filter(
      ({ creator_id, subscribed }) => subscribed > (limits.get(creator_id) ?? 0),
    ).length,
    storageUnits,
  };
}

export type ComplimentaryPlanGrant = {
  id: string;
  userId: string;
  email: string;
  username: string;
  displayName: string;
  planId: "store" | "creator";
  status: "active" | "revoked" | "expired";
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  grantedByEmail: string | null;
  lastSignInAt: string | null;
  userCreatedAt: string;
  billingPlanId: PlanId | null;
  billingStatus: string | null;
  effectivePlanId: PlanId;
};

export async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!error && data) return;
  if (error) {
    console.error("[admin] role lookup failed", { code: error.code });
    throw new Error(ADMIN_DATA_ERROR);
  }

  // Staging has its own Supabase project, so founder access cannot inherit the
  // production user_roles row. Keep the fallback explicitly staging-only and
  // driven by a deploy-time allowlist rather than weakening the production gate.
  if (process.env.APP_ENV === "staging") {
    const allowedEmails = (process.env.FOUNDER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    if (allowedEmails.length) {
      const { data: authUser, error: authError } =
        await supabaseAdmin.auth.admin.getUserById(userId);
      const email = authUser.user?.email?.toLowerCase();
      if (!authError && email && allowedEmails.includes(email)) return;
      if (authError) {
        console.error("[admin] staging allowlist lookup failed", { code: authError.code });
        throw new Error(ADMIN_DATA_ERROR);
      }
    }
  }

  throw new RequestHttpError(403, ADMIN_ACCESS_ERROR);
}

function throwAdminDataError(operation: string, error: { code?: string; message?: string }): never {
  console.error(`[admin] ${operation} failed`, {
    code: error.code,
    message: sanitizeAdminOperationalMessage(error.message),
  });
  throw new Error(ADMIN_DATA_ERROR);
}

async function loadFounderSubscribedContactCounts(): Promise<FounderSubscribedCountRow[]> {
  const counts = new Map<string, number>();
  const pageSize = 1_000;
  // ponytail: keep this founder-only read migration-free; move aggregation into SQL if load grows.
  for (let from = 0; ; from += pageSize) {
    const { data, error } = (await supabaseAdmin
      .from("audience_contacts" as never)
      .select("creator_id" as never)
      .eq("marketing_status" as never, "subscribed" as never)
      .order("creator_id" as never, { ascending: true })
      .range(from, from + pageSize - 1)) as unknown as {
      data: Array<{ creator_id: string }> | null;
      error: { code?: string; message?: string } | null;
    };
    if (error) throwAdminDataError("load subscribed contact capacity", error);
    for (const row of data ?? []) {
      counts.set(row.creator_id, (counts.get(row.creator_id) ?? 0) + 1);
    }
    if ((data?.length ?? 0) < pageSize) break;
  }
  return [...counts].map(([creator_id, subscribed]) => ({ creator_id, subscribed }));
}

function throwComplimentaryPlanError(
  operation: string,
  error: { code?: string; message?: string },
): never {
  const safeMessages = [
    "Complimentary access must use the Store or Creator plan.",
    "Complimentary access duration must be between 1 and 3650 days.",
    "No Bento account was found for that email.",
    "That complimentary plan is no longer active.",
  ];
  const safeMessage = safeMessages.find((message) => error.message?.includes(message));
  if (safeMessage) throw new Error(safeMessage);
  throwAdminDataError(operation, error);
}

export const getComplimentaryPlanGrants = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await supabaseAdmin.rpc("get_founder_complimentary_plan_grants");
    if (error) throwAdminDataError("list complimentary grants", error);

    const userIds = (data ?? []).map((row) => row.user_id);
    const subscriptionResult = userIds.length
      ? await supabaseAdmin
          .from("subscriptions")
          .select("user_id, plan_id, status, updated_at")
          .in("user_id", userIds)
      : { data: [], error: null };
    if (subscriptionResult.error)
      throwAdminDataError("load complimentary billing context", subscriptionResult.error);

    const subscriptions = summarizeAdminSubscriptions(subscriptionResult.data ?? []);

    return (data ?? []).map((row): ComplimentaryPlanGrant => {
      const subscription = subscriptions.get(row.user_id);
      const billingPlan = subscription?.planId ?? null;
      const grantPlan = row.status === "active" ? normalizePlan(row.plan_id) : "free";

      return {
        id: row.id,
        userId: row.user_id,
        email: row.email,
        username: row.username,
        displayName: row.display_name,
        planId: row.plan_id as "store" | "creator",
        status: row.status as "active" | "revoked" | "expired",
        grantedAt: row.granted_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        grantedByEmail: row.granted_by_email,
        lastSignInAt: row.last_sign_in_at,
        userCreatedAt: row.user_created_at,
        billingPlanId: billingPlan,
        billingStatus: subscription?.status ?? null,
        effectivePlanId: highestPlan(grantPlan, billingPlan ?? "free"),
      };
    });
  });

export const grantComplimentaryPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        email: z.string().trim().toLowerCase().email().max(254),
        planId: z.enum(["store", "creator"]),
        durationDays: z.number().int().min(1).max(3650),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.rpc("grant_complimentary_plan", {
      p_email: data.email,
      p_plan_id: data.planId,
      p_granted_by: context.userId,
      p_duration_days: data.durationDays,
    });
    if (error) throwComplimentaryPlanError("grant complimentary plan", error);
    return { success: true };
  });

export const revokeComplimentaryPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ grantId: uuidSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.rpc("revoke_complimentary_plan", {
      p_grant_id: data.grantId,
    });
    if (error) throwComplimentaryPlanError("revoke complimentary plan", error);
    return { success: true };
  });

export const getAdminOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) })
      .extend({ offset: z.number().int().min(0).max(730).default(0) })
      .parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);

    const periodEnd = new Date(Date.now() - data.offset * DAY_MS).toISOString();
    const periodStart = new Date(Date.now() - (data.days + data.offset) * DAY_MS).toISOString();
    const [
      databaseResult,
      creatorRevenueResult,
      planMixResult,
      addonSubscriptionsResult,
      subscribedContactCounts,
      recentBillingResult,
      instagramConnectionsResult,
      instagramAutomationsResult,
      instagramRunsResult,
      socialPreviewAttemptsResult,
      socialPreviewCacheResult,
      socialPreviewBudgetsResult,
      webAnalytics,
    ] = await Promise.all([
      supabaseAdmin.rpc(
        "get_founder_dashboard_database" as never,
        {
          p_period_start: periodStart,
          p_period_end: periodEnd,
          p_days: data.days,
        } as never,
      ),
      supabaseAdmin.rpc(
        "get_founder_creator_revenue" as never,
        {
          p_period_start: periodStart,
          p_period_end: periodEnd,
          p_limit: 50,
        } as never,
      ),
      supabaseAdmin.from("profiles").select("id, plan_id, is_pro"),
      supabaseAdmin
        .from("subscriptions")
        .select("user_id, plan_id, contact_tier_contacts, storage_addon_units")
        .in("status", ["active", "trialing", "past_due"]),
      loadFounderSubscribedContactCounts(),
      supabaseAdmin
        .from("billing_events")
        .select(
          "webhook_id, event_type, user_id, status, attempts, error_message, occurred_at, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(20),
      supabaseAdmin
        .from("social_connections" as never)
        .select(
          "id, connection_health, reauth_required, provider_error_code, last_verified_at, last_webhook_at" as never,
        )
        .eq("provider", "instagram"),
      supabaseAdmin.from("instagram_dm_automations" as never).select("id, enabled" as never),
      supabaseAdmin
        .from("instagram_dm_runs" as never)
        .select(
          "id, status, error_code, error_message, attempt_count, created_at, updated_at" as never,
        )
        .gte("created_at", new Date(Date.now() - DAY_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(50),
      supabaseAdmin
        .from("social_preview_attempts")
        .select(
          "platform, source, attempt_number, outcome, duration_ms, browser_ms, used_bright, created_at",
        )
        .gte("created_at", periodStart)
        .lt("created_at", periodEnd)
        .order("created_at", { ascending: false })
        .limit(10_000),
      supabaseAdmin
        .from("social_preview_cache")
        .select("platform, preview, expires_at, stale_until"),
      supabaseAdmin
        .from("social_preview_budgets")
        .select("provider, period_start, used")
        .gte("period_start", `${new Date().toISOString().slice(0, 7)}-01`),
      getFounderWebAnalytics(data.days, {}, data.offset),
    ]);

    if (databaseResult.error)
      throwAdminDataError("load founder database overview", databaseResult.error);
    if (creatorRevenueResult.error)
      throwAdminDataError("load founder creator revenue", creatorRevenueResult.error);
    if (planMixResult.error) throwAdminDataError("load plan mix", planMixResult.error);
    if (addonSubscriptionsResult.error)
      throwAdminDataError("load add-on capacity", addonSubscriptionsResult.error);
    if (recentBillingResult.error)
      throwAdminDataError("load recent billing events", recentBillingResult.error);
    if (instagramConnectionsResult.error)
      throwAdminDataError("load Instagram connection health", instagramConnectionsResult.error);
    if (instagramAutomationsResult.error)
      throwAdminDataError("load Instagram automations", instagramAutomationsResult.error);
    if (instagramRunsResult.error)
      throwAdminDataError("load Instagram workflow runs", instagramRunsResult.error);
    if (socialPreviewAttemptsResult.error)
      throwAdminDataError("load social-preview attempts", socialPreviewAttemptsResult.error);
    if (socialPreviewCacheResult.error)
      throwAdminDataError("load social-preview cache health", socialPreviewCacheResult.error);
    if (socialPreviewBudgetsResult.error)
      throwAdminDataError("load social-preview budgets", socialPreviewBudgetsResult.error);
    const database = (databaseResult.data ?? {}) as FounderDatabaseOverview;
    const instagramConnections = (instagramConnectionsResult.data ??
      []) as unknown as InstagramConnectionHealthRow[];
    const instagramAutomations = (instagramAutomationsResult.data ??
      []) as unknown as InstagramAutomationHealthRow[];
    const instagramRuns = (instagramRunsResult.data ?? []) as unknown as InstagramRunHealthRow[];
    const chartCurrency = database.revenue?.[0]?.currency ?? "USD";
    const planMix = { free: 0, store: 0, creator: 0 };
    const plansByUser = new Map<string, PlanId>();
    for (const profile of planMixResult.data ?? []) {
      const profilePlan = normalizePlan(profile.plan_id, Boolean(profile.is_pro));
      planMix[profilePlan] += 1;
      plansByUser.set(profile.id, profilePlan);
    }
    const journeyUserIds = Array.from(
      new Set(
        webAnalytics.journeys
          .map((journey) => journey.distinctId)
          .filter((id) => uuidSchema.safeParse(id).success),
      ),
    );

    let journeyContextRows: JourneyContextRow[] = [];
    if (journeyUserIds.length) {
      const journeyContextResult = await supabaseAdmin.rpc(
        "get_founder_journey_context" as never,
        { p_user_ids: journeyUserIds, p_currency: chartCurrency } as never,
      );
      if (journeyContextResult.error)
        throwAdminDataError("load founder journey context", journeyContextResult.error);
      journeyContextRows = (journeyContextResult.data ?? []) as JourneyContextRow[];
    }
    const journeyContext = new Map(journeyContextRows.map((row) => [row.user_id, row]));
    const journeys = webAnalytics.journeys.map((journey) => {
      const user = journeyContext.get(journey.distinctId);
      return {
        id: journey.distinctId,
        username: user?.username ?? "anonymous",
        email: user?.email ?? null,
        source: journey.source,
        country: journey.country,
        device: journey.device,
        operatingSystem: journey.operatingSystem,
        browser: journey.browser,
        spent: Number(user?.spent ?? 0),
        currency: chartCurrency,
        timeToCompleteSeconds: journey.timeToCompleteSeconds,
        completedAt: journey.completedAt,
      };
    });

    const sourceGroups = new Map<
      string,
      { platform: string; source: string; attempts: number; successes: number; durationMs: number }
    >();
    for (const attempt of socialPreviewAttemptsResult.data ?? []) {
      const key = `${attempt.platform}:${attempt.source}`;
      const group = sourceGroups.get(key) ?? {
        platform: attempt.platform,
        source: attempt.source,
        attempts: 0,
        successes: 0,
        durationMs: 0,
      };
      group.attempts += 1;
      group.successes += attempt.outcome === "success" ? 1 : 0;
      group.durationMs += attempt.duration_ms;
      sourceGroups.set(key, group);
    }
    const now = Date.now();
    const cacheRows = socialPreviewCacheResult.data ?? [];
    const previewAvailable = (preview: unknown) =>
      !!preview &&
      typeof preview === "object" &&
      !Array.isArray(preview) &&
      (preview as Record<string, unknown>).available === true;
    const today = new Date().toISOString().slice(0, 10);
    const month = `${today.slice(0, 7)}-01`;
    const budgetRows = socialPreviewBudgetsResult.data ?? [];
    const budgetUsed = (provider: string, periodStart: string) =>
      Number(
        budgetRows.find((row) => row.provider === provider && row.period_start === periodStart)
          ?.used ?? 0,
      );
    const brightLimit =
      (globalThis.__env__ as { APP_ENV?: string } | undefined)?.APP_ENV === "production"
        ? 3_500
        : 500;
    const browserLimitMs = 4 * 60 * 1_000;

    return {
      generatedAt: new Date().toISOString(),
      selectedDays: data.days,
      selectedOffset: data.offset,
      totals: { ...database.totals, ...planMix },
      addons: summarizeFounderAddons(
        addonSubscriptionsResult.data ?? [],
        planMixResult.data ?? [],
        subscribedContactCounts,
      ),
      funnel: database.funnel ?? [],
      activity: database.activity,
      revenue: database.revenue ?? [],
      periodRevenue: database.periodRevenue ?? [],
      creatorRevenue: (creatorRevenueResult.data ?? {
        creatorCount: 0,
        totals: [],
        leaderboard: [],
      }) as FounderCreatorRevenue,
      webAnalytics,
      dailySignups: database.dailySignups ?? [],
      dailyRevenue: database.dailyRevenue ?? [],
      journeys,
      socialPreviews: {
        attempts: socialPreviewAttemptsResult.data?.length ?? 0,
        sources: [...sourceGroups.values()]
          .map((group) => ({
            platform: group.platform,
            source: group.source,
            attempts: group.attempts,
            successes: group.successes,
            successRate: group.attempts ? group.successes / group.attempts : 0,
            averageDurationMs: group.attempts ? Math.round(group.durationMs / group.attempts) : 0,
          }))
          .sort((a, b) => b.attempts - a.attempts),
        cache: {
          total: cacheRows.length,
          stale: cacheRows.filter(
            (row) =>
              previewAvailable(row.preview) &&
              Date.parse(row.expires_at) <= now &&
              Date.parse(row.stale_until) > now,
          ).length,
          unavailable: cacheRows.filter((row) => !previewAvailable(row.preview)).length,
        },
        bright: {
          used: budgetUsed("bright_data", month),
          limit: brightLimit,
          remaining: Math.max(0, brightLimit - budgetUsed("bright_data", month)),
        },
        browser: {
          usedMs: budgetUsed("browser_run", today),
          limitMs: browserLimitMs,
          remainingMs: Math.max(0, browserLimitMs - budgetUsed("browser_run", today)),
        },
      },
      recentUsers: (database.recentUsers ?? []).map((user) => ({
        ...user,
        planId: plansByUser.get(user.id) ?? "free",
      })),
      recentBillingEvents: (recentBillingResult.data ?? []).map((event) => ({
        ...event,
        error_message: sanitizeAdminOperationalMessage(event.error_message),
      })),
      instagramAutoDm: {
        connections: {
          total: instagramConnections.length,
          healthy: instagramConnections.filter(
            (connection) =>
              connection.connection_health === "healthy" && !connection.reauth_required,
          ).length,
          actionRequired: instagramConnections.filter(
            (connection) =>
              connection.connection_health !== "healthy" || connection.reauth_required,
          ).length,
          reauthRequired: instagramConnections.filter((connection) => connection.reauth_required)
            .length,
        },
        automations: {
          total: instagramAutomations.length,
          enabled: instagramAutomations.filter((automation) => automation.enabled).length,
        },
        runs24h: {
          total: instagramRuns.length,
          completed: instagramRuns.filter((run) => run.status === "completed").length,
          awaiting: instagramRuns.filter((run) =>
            ["awaiting_confirmation", "awaiting_email", "delivering"].includes(run.status),
          ).length,
          failed: instagramRuns.filter((run) => run.status === "failed").length,
        },
        recentFailures: instagramRuns
          .filter((run) => run.status === "failed")
          .slice(0, 10)
          .map((run) => ({
            id: run.id,
            errorCode: run.error_code,
            errorMessage: sanitizeAdminOperationalMessage(run.error_message),
            attempts: run.attempt_count,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
          })),
      },
    };
  });

const EXPLORE_REVIEW_PAGE_SIZE = 40;

export type ExploreReviewItem = {
  userId: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  email: string | null;
  category: ExploreCategory;
  showInExplore: boolean;
  onboarded: boolean;
  noindex: boolean;
  cardCount: number;
  status: ExploreReviewStatus;
  optedInAt: string | null;
  reviewedAt: string | null;
};

export const getExploreReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        queue: exploreReviewQueueSchema.default("pending"),
        page: z.number().int().min(1).max(500).default(1),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const from = (data.page - 1) * EXPLORE_REVIEW_PAGE_SIZE;
    const { data: rows, error } = await supabaseAdmin.rpc("get_founder_explore_reviews", {
      p_queue: data.queue,
      p_limit: EXPLORE_REVIEW_PAGE_SIZE,
      p_offset: from,
    });
    if (error) throwAdminDataError("load explore reviews", error);

    const items: ExploreReviewItem[] = sortExploreReviewsNewestFirst(
      (rows ?? []).filter((row) => Boolean(row.user_id)),
      data.queue,
    ).map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      bio: row.bio ?? "",
      avatarUrl: safePublicMediaUrl(row.avatar_url),
      email: row.email,
      category: exploreCategorySchema.catch("creator").parse(row.explore_category),
      showInExplore: row.show_in_explore,
      onboarded: row.onboarded,
      noindex: row.noindex,
      cardCount: Number(row.card_count ?? 0),
      status: row.explore_review_status as ExploreReviewStatus,
      optedInAt: row.explore_opted_in_at,
      reviewedAt: row.explore_reviewed_at,
    }));

    return {
      queue: data.queue as ExploreReviewQueue,
      page: data.page,
      pageSize: EXPLORE_REVIEW_PAGE_SIZE,
      total: Number(rows?.[0]?.total_count ?? 0),
      pendingCount: Number(rows?.[0]?.pending_count ?? 0),
      items,
    };
  });

export const reviewExploreProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        userId: uuidSchema,
        action: z.enum(["approve", "reject"]),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const [{ data: profile, error: loadError }, cardsResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, username, show_in_explore, explore_review_status")
        .eq("id", data.userId)
        .maybeSingle(),
      supabaseAdmin
        .from("blocks")
        .select("id", { count: "exact", head: true })
        .eq("user_id", data.userId)
        .is("page_id", null),
    ]);
    if (loadError) throwAdminDataError("load explore review profile", loadError);
    if (cardsResult.error) throwAdminDataError("count explore review cards", cardsResult.error);
    if (!profile) throw new Error("That creator page could not be found.");
    if (data.action === "approve") {
      if (!profile.show_in_explore) throw new Error("That creator has not opted in to Explore.");
      if (!isReadyForExploreReview(cardsResult.count ?? 0)) {
        throw new Error("That Surf needs more than 3 cards before it can go on Explore.");
      }
    }

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({
        explore_review_status: data.action === "approve" ? "approved" : "rejected",
        explore_reviewed_at: new Date().toISOString(),
        explore_reviewed_by: context.userId,
      })
      .eq("id", data.userId);
    if (error) throwAdminDataError("save explore review", error);
    return { success: true as const, action: data.action };
  });
