import { z } from "zod";
import {
  getAdminOverview,
  getComplimentaryPlanGrants,
  getExploreReviews,
  grantComplimentaryPlan,
  reviewExploreProfile,
  revokeComplimentaryPlan,
} from "./admin.functions";
import {
  getFounderAffiliates,
  reviewReachSubmission,
  setReferralAccountRate,
  setReferralAccountStatus,
  transitionReferralPayout,
  updateReferralSettings,
} from "./referral-admin.functions";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(100).default(50);
type AffiliateRow = {
  id: string;
  username: string;
  displayName: string | null;
  code: string;
  status: string;
  commission_rate_bps: number | null;
  clicks: number;
  repeatClicks: number;
  referrals: number;
  customers: number;
  earnings: number;
  currency: string;
};
type AffiliatePayoutRow = {
  id: string;
  account_id: string;
  currency: string;
  amount: number;
  status: string;
  requested_at: string;
};
type AffiliateReachRow = {
  id: string;
  account_id: string;
  provider: string;
  status: string;
  final_views: number | null;
  reward_amount: number | null;
  currency: string;
  created_at: string;
};
const overviewInput = z
  .object({
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
    offset: z.number().int().min(0).max(730).default(0),
  })
  .strict();
const exploreReadInput = z
  .object({
    queue: z.enum(["pending", "live", "rejected"]).default("pending"),
    page: z.number().int().min(1).max(500).default(1),
  })
  .strict();
const grantsReadInput = z
  .object({ status: z.enum(["active", "revoked", "expired"]).optional(), limit })
  .strict();
const affiliatesReadInput = z.object({ limit }).strict();
const exploreReviewInput = z
  .object({ userId: uuid, action: z.enum(["approve", "reject"]) })
  .strict();
const complimentaryInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("grant"),
      creatorEmail: z.string().trim().toLowerCase().email().max(254),
      planId: z.enum(["store", "creator"]),
      durationDays: z.number().int().min(1).max(3650),
    })
    .strict(),
  z.object({ action: z.literal("revoke"), grantId: uuid }).strict(),
]);
const affiliateAccountInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set_status"),
      accountId: uuid,
      status: z.enum(["active", "suspended"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_rate"),
      accountId: uuid,
      commissionRateBps: z.number().int().min(0).max(10_000).nullable(),
    })
    .strict(),
]);
const payoutInput = z
  .object({
    payoutId: uuid,
    status: z.enum(["approved", "processing", "paid", "rejected", "failed"]),
    reference: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((input) => input.status !== "paid" || input.reference, {
    message: "A transfer reference is required when marking a payout paid.",
    path: ["reference"],
  });
const reachInput = z
  .object({
    submissionId: uuid,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const referralPolicyInput = z
  .object({
    enabled: z.boolean(),
    commissionRateBps: z.number().int().min(0).max(10_000),
    attributionWindowDays: z.number().int().min(1).max(365),
    commissionHoldDays: z.number().int().min(0).max(365),
    payoutMinimumUsd: z.number().int().min(0),
    reachCap: z.number().int().min(0),
    reachRates: z
      .object({
        twitter: z.number().int().min(0),
        linkedin: z.number().int().min(0),
        instagram: z.number().int().min(0),
        threads: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

const idSchema = { type: "string", format: "uuid" } as const;
const limitSchema = { type: "integer", minimum: 1, maximum: 100, default: 50 } as const;
const safePublicText = (value: string | null, maxLength = 120) =>
  value
    ?.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/\bhttps?:\/\/\S+/gi, "[url redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/gi, "[redacted]")
    .slice(0, maxLength) ?? null;
const breakdown = (
  rows: Array<{ label: string; visitors: number; conversions: number; revenue: number }> = [],
) =>
  rows.slice(0, 12).map((row) => ({
    label: safePublicText(row.label),
    visitors: row.visitors,
    conversions: row.conversions,
    revenue: row.revenue,
  }));

function adminOverviewSummary(data: Awaited<ReturnType<typeof getAdminOverview>>) {
  const web = data.webAnalytics;
  return {
    generatedAt: data.generatedAt,
    selectedDays: data.selectedDays,
    selectedOffset: data.selectedOffset,
    totals: {
      users: data.totals.users,
      onboarded: data.totals.onboarded,
      pro: data.totals.pro,
      free: data.totals.free,
      store: data.totals.store,
      creator: data.totals.creator,
      newUsers7d: data.totals.newUsers7d,
      newUsersPeriod: data.totals.newUsersPeriod,
    },
    funnel: data.funnel
      .slice(0, 20)
      .map(({ label, value }) => ({ label: safePublicText(label), value })),
    activity: {
      creatorActive7d: data.activity.creatorActive7d,
      creatorActive30d: data.activity.creatorActive30d,
      pagesWithVisitors7d: data.activity.pagesWithVisitors7d,
      pagesWithVisitors30d: data.activity.pagesWithVisitors30d,
    },
    revenue: data.revenue.slice(0, 20).map(({ currency, gross, refunds, net, mrr }) => ({
      currency,
      gross,
      refunds,
      net,
      mrr,
    })),
    periodRevenue: data.periodRevenue
      .slice(0, 20)
      .map(({ currency, gross, refunds, net }) => ({ currency, gross, refunds, net })),
    creatorRevenue: {
      creatorCount: data.creatorRevenue.creatorCount,
      totals: data.creatorRevenue.totals
        .slice(0, 20)
        .map(({ currency, creators, orders, gross, refunds, revenue, net, fees }) => ({
          currency,
          creators,
          orders,
          gross,
          refunds,
          revenue,
          net,
          fees,
        })),
      leaderboard: data.creatorRevenue.leaderboard
        .slice(0, 50)
        .map(
          ({
            rank,
            username,
            displayName,
            currency,
            orders,
            customers,
            gross,
            refunds,
            revenue,
            net,
            fees,
            latestSaleAt,
          }) => ({
            rank,
            username,
            displayName: safePublicText(displayName),
            currency,
            orders,
            customers,
            gross,
            refunds,
            revenue,
            net,
            fees,
            latestSaleAt,
          }),
        ),
    },
    analytics: {
      available: web.available,
      overview: {
        pageviews: web.overview.pageviews,
        visitors: web.overview.visitors,
        conversions: web.overview.conversions,
        online: web.overview.online,
        previousPageviews: web.overview.previousPageviews,
        previousVisitors: web.overview.previousVisitors,
        previousConversions: web.overview.previousConversions,
        bounceRate: web.overview.bounceRate,
        averageSessionSeconds: web.overview.averageSessionSeconds,
      },
      daily: web.daily.slice(0, 90).map(({ date, visitors, conversions }) => ({
        date,
        visitors,
        conversions,
      })),
      acquisitionChannels: breakdown(web.acquisition.channels),
      geography: {
        countries: breakdown(web.geography.countries),
        regions: breakdown(web.geography.regions),
        cities: breakdown(web.geography.cities),
      },
      technology: {
        browsers: breakdown(web.technology.browsers),
        operatingSystems: breakdown(web.technology.operatingSystems),
        devices: breakdown(web.technology.devices),
      },
      crawlers: {
        aiAnswers: web.crawlers.aiAnswers.slice(0, 20).map((row) => ({
          label: safePublicText(row.label),
          visits: row.visits,
          share: row.share,
        })),
        indexing: web.crawlers.indexing.slice(0, 20).map((row) => ({
          label: safePublicText(row.label),
          visits: row.visits,
          share: row.share,
        })),
        training: web.crawlers.training.slice(0, 20).map((row) => ({
          label: safePublicText(row.label),
          visits: row.visits,
          share: row.share,
        })),
      },
      journeyCount: data.journeys.length,
    },
    dailySignups: data.dailySignups.slice(0, 90),
    dailyRevenue: data.dailyRevenue.slice(0, 90),
    recentCreators: data.recentUsers.slice(0, 50).map((user) => ({
      username: user.username,
      displayName: safePublicText(user.displayName),
      planId: user.planId,
      onboarded: user.onboarded,
      createdAt: user.createdAt,
      lastSignInAt: user.lastSignInAt,
      subscriptionStatus: user.subscriptionStatus,
      amount: user.amount,
      currency: user.currency,
    })),
    billingHealth: data.recentBillingEvents.slice(0, 20).map((event) => ({
      eventType: event.event_type,
      status: event.status,
      attempts: event.attempts,
      createdAt: event.created_at,
      occurredAt: event.occurred_at,
    })),
    socialPreviews: {
      attempts: data.socialPreviews.attempts,
      sources: data.socialPreviews.sources.slice(0, 20).map((source) => ({
        platform: safePublicText(source.platform),
        source: safePublicText(source.source),
        attempts: source.attempts,
        successes: source.successes,
        successRate: source.successRate,
        averageDurationMs: source.averageDurationMs,
      })),
      cache: {
        total: data.socialPreviews.cache.total,
        stale: data.socialPreviews.cache.stale,
        unavailable: data.socialPreviews.cache.unavailable,
      },
      bright: {
        used: data.socialPreviews.bright.used,
        limit: data.socialPreviews.bright.limit,
        remaining: data.socialPreviews.bright.remaining,
      },
      browser: {
        usedMs: data.socialPreviews.browser.usedMs,
        limitMs: data.socialPreviews.browser.limitMs,
        remainingMs: data.socialPreviews.browser.remainingMs,
      },
    },
    instagramAutoDm: {
      connections: {
        total: data.instagramAutoDm.connections.total,
        healthy: data.instagramAutoDm.connections.healthy,
        actionRequired: data.instagramAutoDm.connections.actionRequired,
        reauthRequired: data.instagramAutoDm.connections.reauthRequired,
      },
      automations: {
        total: data.instagramAutoDm.automations.total,
        enabled: data.instagramAutoDm.automations.enabled,
      },
      runs24h: {
        total: data.instagramAutoDm.runs24h.total,
        completed: data.instagramAutoDm.runs24h.completed,
        awaiting: data.instagramAutoDm.runs24h.awaiting,
        failed: data.instagramAutoDm.runs24h.failed,
      },
      recentFailureCount: data.instagramAutoDm.recentFailures.length,
    },
  };
}

function exploreReviewsSummary(data: Awaited<ReturnType<typeof getExploreReviews>>) {
  return {
    queue: data.queue,
    page: data.page,
    pageSize: data.pageSize,
    total: data.total,
    pendingCount: data.pendingCount,
    items: data.items.map((item) => ({
      userId: item.userId,
      username: item.username,
      displayName: safePublicText(item.displayName),
      category: item.category,
      showInExplore: item.showInExplore,
      onboarded: item.onboarded,
      noindex: item.noindex,
      cardCount: item.cardCount,
      status: item.status,
      optedInAt: item.optedInAt,
      reviewedAt: item.reviewedAt,
    })),
  };
}

function complimentaryGrantsSummary(
  rows: Awaited<ReturnType<typeof getComplimentaryPlanGrants>>,
  status: "active" | "revoked" | "expired" | undefined,
  count: number,
) {
  return rows
    .filter((row) => !status || row.status === status)
    .slice(0, count)
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: safePublicText(row.displayName),
      planId: row.planId,
      status: row.status,
      grantedAt: row.grantedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      lastSignInAt: row.lastSignInAt,
      userCreatedAt: row.userCreatedAt,
      billingPlanId: row.billingPlanId,
      billingStatus: row.billingStatus,
      effectivePlanId: row.effectivePlanId,
    }));
}

function affiliateSummary(data: Awaited<ReturnType<typeof getFounderAffiliates>>, count: number) {
  return {
    settings: {
      enabled: data.settings.enabled,
      commissionRateBps: data.settings.commission_rate_bps,
      attributionWindowDays: data.settings.attribution_window_days,
      commissionHoldDays: data.settings.commission_hold_days,
      payoutMinimumUsd: data.settings.payout_minimums?.USD ?? 0,
      reachCap: data.settings.reach_cap,
      reachRates: {
        twitter: data.settings.reach_rates?.twitter ?? 0,
        linkedin: data.settings.reach_rates?.linkedin ?? 0,
        instagram: data.settings.reach_rates?.instagram ?? 0,
        threads: data.settings.reach_rates?.threads ?? 0,
      },
    },
    totals: Object.fromEntries(Object.entries(data.totals).slice(0, 10)),
    counts: {
      clicks: data.clicks,
      referrals: data.referrals,
      customers: data.customers,
      affiliates: data.affiliates.length,
      payouts: data.payouts.length,
      reachSubmissions: data.reach.length,
    },
    affiliates: data.affiliates.slice(0, count).map((item: AffiliateRow) => ({
      id: item.id,
      username: item.username,
      displayName: safePublicText(item.displayName),
      code: item.code,
      status: item.status,
      commissionRateBps: item.commission_rate_bps,
      clicks: item.clicks,
      repeatClicks: item.repeatClicks,
      referrals: item.referrals,
      customers: item.customers,
      earnings: item.earnings,
      currency: item.currency,
    })),
    payouts: data.payouts.slice(0, count).map((item: AffiliatePayoutRow) => ({
      id: item.id,
      accountId: item.account_id,
      currency: item.currency,
      amount: item.amount,
      status: item.status,
      requestedAt: item.requested_at,
    })),
    reach: data.reach.slice(0, count).map((item: AffiliateReachRow) => ({
      id: item.id,
      accountId: item.account_id,
      provider: item.provider,
      status: item.status,
      finalViews: item.final_views,
      rewardAmount: item.reward_amount,
      currency: item.currency,
      createdAt: item.created_at,
    })),
  };
}

async function runConfirmed(
  title: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  run: () => Promise<unknown>,
  refresh: () => Promise<unknown>,
) {
  signal.throwIfAborted();
  await requireWebMcpUserConfirmation(title, input);
  signal.throwIfAborted();
  await run();
  signal.throwIfAborted();
  await refresh();
  signal.throwIfAborted();
}

export function createAdminWebMcpTools({
  refresh,
}: {
  refresh: () => Promise<unknown>;
}): WebMcpTool[] {
  const referralPolicyProperties = {
    enabled: { type: "boolean" },
    commissionRateBps: { type: "integer", minimum: 0, maximum: 10_000 },
    attributionWindowDays: { type: "integer", minimum: 1, maximum: 365 },
    commissionHoldDays: { type: "integer", minimum: 0, maximum: 365 },
    payoutMinimumUsd: { type: "integer", minimum: 0 },
    reachCap: { type: "integer", minimum: 0 },
    reachRates: {
      type: "object",
      additionalProperties: false,
      properties: {
        twitter: { type: "integer", minimum: 0 },
        linkedin: { type: "integer", minimum: 0 },
        instagram: { type: "integer", minimum: 0 },
        threads: { type: "integer", minimum: 0 },
      },
      required: ["twitter", "linkedin", "instagram", "threads"],
    },
  };

  return [
    {
      name: "bento_get_admin_overview",
      title: "Get founder admin overview",
      description:
        "Loads bounded founder analytics, creator, revenue, billing-health, social-preview, and Instagram DM summaries. Emails, user IDs, raw paths/referrers, provider payloads, private URLs, and error details are omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          days: { type: "integer", enum: [7, 30, 90], default: 30 },
          offset: { type: "integer", minimum: 0, maximum: 730, default: 0 },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = overviewInput.parse(rawInput);
        signal.throwIfAborted();
        const data = await getAdminOverview({ data: input });
        signal.throwIfAborted();
        return webMcpResult("Loaded the founder admin overview.", {
          overview: adminOverviewSummary(data),
        });
      },
    },
    {
      name: "bento_get_admin_explore_reviews",
      title: "Get admin Explore reviews",
      description:
        "Loads one bounded Explore review queue page. Creator emails, bios, media URLs, and internal review payloads are omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          queue: { type: "string", enum: ["pending", "live", "rejected"], default: "pending" },
          page: { type: "integer", minimum: 1, maximum: 500, default: 1 },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = exploreReadInput.parse(rawInput);
        signal.throwIfAborted();
        const data = await getExploreReviews({ data: input });
        signal.throwIfAborted();
        return webMcpResult("Loaded the admin Explore review queue.", {
          reviews: exploreReviewsSummary(data),
        });
      },
    },
    {
      name: "bento_get_admin_complimentary_plans",
      title: "Get admin complimentary plans",
      description:
        "Lists bounded complimentary-plan state. Account and founder emails, internal user IDs, and billing-provider identifiers are omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["active", "revoked", "expired"] },
          limit: limitSchema,
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = grantsReadInput.parse(rawInput);
        signal.throwIfAborted();
        const rows = await getComplimentaryPlanGrants();
        signal.throwIfAborted();
        const grants = complimentaryGrantsSummary(rows, input.status, input.limit);
        return webMcpResult(`Loaded ${grants.length} complimentary plan grant(s).`, { grants });
      },
    },
    {
      name: "bento_get_admin_affiliates",
      title: "Get founder affiliate operations",
      description:
        "Loads bounded referral policy, account, payout, and reach-review state. Social-post URLs, provider references, visitor hashes, payment IDs, private media, and raw records are omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { limit: limitSchema },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = affiliatesReadInput.parse(rawInput);
        signal.throwIfAborted();
        const data = await getFounderAffiliates();
        signal.throwIfAborted();
        return webMcpResult("Loaded founder affiliate operations.", {
          affiliates: affiliateSummary(data, input.limit),
        });
      },
    },
    {
      name: "bento_review_admin_explore_profile",
      title: "Review an Explore profile",
      description:
        "Approves or rejects one eligible creator page for Explore after browser confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          userId: idSchema,
          action: { type: "string", enum: ["approve", "reject"] },
        },
        required: ["userId", "action"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = exploreReviewInput.parse(rawInput);
        await runConfirmed(
          "Review Explore profile",
          input,
          signal,
          () => reviewExploreProfile({ data: input }),
          refresh,
        );
        return webMcpResult("Explore profile review saved.", {
          ok: true,
          userId: input.userId,
          action: input.action,
        });
      },
    },
    {
      name: "bento_manage_admin_complimentary_plan",
      title: "Manage a complimentary plan",
      description:
        "Grants a bounded complimentary Store or Creator plan, or revokes one grant, after browser confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["grant", "revoke"] },
          creatorEmail: { type: "string", format: "email", maxLength: 254 },
          planId: { type: "string", enum: ["store", "creator"] },
          durationDays: { type: "integer", minimum: 1, maximum: 3650 },
          grantId: idSchema,
        },
        required: ["action"],
        oneOf: [
          {
            properties: { action: { const: "grant" } },
            required: ["action", "creatorEmail", "planId", "durationDays"],
          },
          { properties: { action: { const: "revoke" } }, required: ["action", "grantId"] },
        ],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = complimentaryInput.parse(rawInput);
        await runConfirmed(
          "Manage complimentary plan",
          input,
          signal,
          () =>
            input.action === "grant"
              ? grantComplimentaryPlan({
                  data: {
                    email: input.creatorEmail,
                    planId: input.planId,
                    durationDays: input.durationDays,
                  },
                })
              : revokeComplimentaryPlan({ data: { grantId: input.grantId } }),
          refresh,
        );
        return webMcpResult("Complimentary plan updated.", {
          ok: true,
          action: input.action,
          ...(input.action === "revoke" ? { grantId: input.grantId } : {}),
        });
      },
    },
    {
      name: "bento_manage_admin_affiliate_account",
      title: "Manage an affiliate account",
      description:
        "Activates or suspends an affiliate account, or changes its future commission rate, after browser confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["set_status", "set_rate"] },
          accountId: idSchema,
          status: { type: "string", enum: ["active", "suspended"] },
          commissionRateBps: { type: ["integer", "null"], minimum: 0, maximum: 10_000 },
        },
        required: ["action", "accountId"],
        oneOf: [
          {
            properties: { action: { const: "set_status" } },
            required: ["action", "accountId", "status"],
          },
          {
            properties: { action: { const: "set_rate" } },
            required: ["action", "accountId", "commissionRateBps"],
          },
        ],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = affiliateAccountInput.parse(rawInput);
        await runConfirmed(
          "Manage affiliate account",
          input,
          signal,
          () =>
            input.action === "set_status"
              ? setReferralAccountStatus({
                  data: { accountId: input.accountId, status: input.status },
                })
              : setReferralAccountRate({
                  data: {
                    accountId: input.accountId,
                    commissionRateBps: input.commissionRateBps,
                  },
                }),
          refresh,
        );
        return webMcpResult("Affiliate account updated.", {
          ok: true,
          action: input.action,
          accountId: input.accountId,
        });
      },
    },
    {
      name: "bento_transition_admin_affiliate_payout",
      title: "Transition an affiliate payout",
      description:
        "Moves one referral payout through an allowed operational state after browser confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          payoutId: idSchema,
          status: {
            type: "string",
            enum: ["approved", "processing", "paid", "rejected", "failed"],
          },
          reference: { type: "string", minLength: 1, maxLength: 200 },
        },
        required: ["payoutId", "status"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = payoutInput.parse(rawInput);
        await runConfirmed(
          "Transition affiliate payout",
          input,
          signal,
          () => transitionReferralPayout({ data: input }),
          refresh,
        );
        return webMcpResult("Affiliate payout updated.", {
          ok: true,
          payoutId: input.payoutId,
          status: input.status,
        });
      },
    },
    {
      name: "bento_review_admin_affiliate_reach",
      title: "Review an affiliate reach reward",
      description:
        "Approves or rejects one measured referral reach submission after browser confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          submissionId: idSchema,
          decision: { type: "string", enum: ["approved", "rejected"] },
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["submissionId", "decision"],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = reachInput.parse(rawInput);
        await runConfirmed(
          "Review affiliate reach reward",
          input,
          signal,
          () => reviewReachSubmission({ data: input }),
          refresh,
        );
        return webMcpResult("Affiliate reach reward reviewed.", {
          ok: true,
          submissionId: input.submissionId,
          decision: input.decision,
        });
      },
    },
    {
      name: "bento_update_admin_referral_policy",
      title: "Update founder referral policy",
      description:
        "Updates future referral commission, attribution, payout, and reach-reward policy after browser confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: referralPolicyProperties,
        required: [
          "enabled",
          "commissionRateBps",
          "attributionWindowDays",
          "commissionHoldDays",
          "payoutMinimumUsd",
          "reachCap",
          "reachRates",
        ],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (rawInput, { signal }) => {
        const input = referralPolicyInput.parse(rawInput);
        await runConfirmed(
          "Update referral policy",
          input,
          signal,
          () => updateReferralSettings({ data: input }),
          refresh,
        );
        return webMcpResult("Referral policy updated.", { ok: true });
      },
    },
  ];
}
