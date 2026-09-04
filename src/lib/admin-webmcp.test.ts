// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { createAdminWebMcpTools } from "./admin-webmcp";
import adminRouteSource from "../routes/_authenticated/admin.tsx?raw";

vi.mock("./admin.functions", () => ({
  getAdminOverview: vi.fn(),
  getComplimentaryPlanGrants: vi.fn(),
  getExploreReviews: vi.fn(),
  grantComplimentaryPlan: vi.fn(),
  reviewExploreProfile: vi.fn(),
  revokeComplimentaryPlan: vi.fn(),
}));
vi.mock("./referral-admin.functions", () => ({
  getFounderAffiliates: vi.fn(),
  reviewReachSubmission: vi.fn(),
  setReferralAccountRate: vi.fn(),
  setReferralAccountStatus: vi.fn(),
  transitionReferralPayout: vi.fn(),
  updateReferralSettings: vi.fn(),
}));

const userId = "11111111-1111-4111-8111-111111111111";
const grantId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const payoutId = "44444444-4444-4444-8444-444444444444";
const submissionId = "55555555-5555-4555-8555-555555555555";
const signal = new AbortController().signal;
const policy = {
  enabled: true,
  commissionRateBps: 2_000,
  attributionWindowDays: 30,
  commissionHoldDays: 14,
  payoutMinimumUsd: 5_000,
  reachCap: 10_000,
  reachRates: { twitter: 1_000, linkedin: 2_500, instagram: 500, threads: 500 },
};

function tool(name: string, refresh = vi.fn().mockResolvedValue(undefined)) {
  return createAdminWebMcpTools({ refresh }).find((item) => item.name === name)!;
}

function mockReads() {
  vi.mocked(getAdminOverview).mockResolvedValue({
    generatedAt: "2026-08-30T00:00:00.000Z",
    selectedDays: 30,
    selectedOffset: 0,
    totals: {
      users: 100,
      onboarded: 80,
      pro: 20,
      free: 60,
      store: 25,
      creator: 15,
      newUsers7d: 8,
      newUsersPeriod: 30,
    },
    funnel: [{ label: "Signed up", value: 100 }],
    activity: {
      creatorActive7d: 20,
      creatorActive30d: 50,
      pagesWithVisitors7d: 30,
      pagesWithVisitors30d: 70,
    },
    revenue: [{ currency: "USD", gross: 10_000, refunds: 500, net: 9_500, mrr: 4_000 }],
    periodRevenue: [{ currency: "USD", gross: 3_000, refunds: 100, net: 2_900 }],
    creatorRevenue: {
      creatorCount: 1,
      totals: [
        {
          currency: "USD",
          creators: 1,
          orders: 2,
          gross: 2_000,
          refunds: 0,
          revenue: 2_000,
          net: 1_900,
          fees: 100,
        },
      ],
      leaderboard: [
        {
          rank: 1,
          creatorId: "private-creator-id",
          username: "safe_creator",
          displayName: "Safe Creator",
          avatarUrl: "https://storage.example/private-avatar",
          currency: "USD",
          orders: 2,
          customers: 2,
          gross: 2_000,
          refunds: 0,
          revenue: 2_000,
          net: 1_900,
          fees: 100,
          latestSaleAt: "2026-08-29T00:00:00.000Z",
        },
      ],
    },
    webAnalytics: {
      available: true,
      error: "private-provider-error",
      days: 30,
      offset: 0,
      overview: {
        pageviews: 500,
        visitors: 300,
        conversions: 20,
        online: 3,
        previousPageviews: 450,
        previousVisitors: 280,
        previousConversions: 18,
        bounceRate: 40,
        averageSessionSeconds: 90,
      },
      daily: [{ date: "2026-08-30", visitors: 10, conversions: 2 }],
      acquisition: {
        channels: [{ label: "Social", visitors: 10, conversions: 2, revenue: 500 }],
        referrers: [
          {
            label: "https://internal.example/private-referrer?token=secret",
            visitors: 1,
            conversions: 0,
            revenue: 0,
          },
        ],
        campaigns: [],
        keywords: [],
      },
      geography: {
        countries: [{ label: "India", visitors: 10, conversions: 2, revenue: 500 }],
        regions: [],
        cities: [],
      },
      content: {
        hostnames: [],
        pages: [{ label: "/access/private-token", visitors: 1, conversions: 0, revenue: 0 }],
        entryPages: [],
        exitLinks: [],
      },
      technology: {
        browsers: [{ label: "Chrome", visitors: 10, conversions: 2, revenue: 500 }],
        operatingSystems: [],
        devices: [],
      },
      journeys: [
        {
          distinctId: "private-visitor-id",
          source: "https://internal.example/private-journey",
          country: "India",
          device: "Desktop",
          operatingSystem: "macOS",
          browser: "Chrome",
          firstSeenAt: null,
          completedAt: null,
          timeToCompleteSeconds: 0,
        },
      ],
      crawlers: { aiAnswers: [], indexing: [], training: [] },
    },
    dailySignups: [{ date: "2026-08-30", signups: 2 }],
    dailyRevenue: [{ date: "2026-08-30", revenue: 500, currency: "USD" }],
    journeys: [
      {
        id: "private-journey-id",
        username: "safe_creator",
        email: "journey@example.com",
        source: "https://internal.example/private-journey",
        country: "India",
        device: "Desktop",
        operatingSystem: "macOS",
        browser: "Chrome",
        spent: 500,
        timeToCompleteSeconds: 60,
        completedAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    socialPreviews: {
      attempts: 4,
      sources: [
        {
          platform: "instagram",
          source: "official",
          attempts: 4,
          successes: 3,
          successRate: 0.75,
          averageDurationMs: 120,
        },
      ],
      cache: { total: 3, stale: 1, unavailable: 0 },
      bright: { used: 2, limit: 500, remaining: 498 },
      browser: { usedMs: 1_000, limitMs: 240_000, remainingMs: 239_000 },
    },
    recentUsers: [
      {
        id: "private-user-id",
        email: "creator@example.com",
        username: "safe_creator",
        displayName: "creator@example.com",
        isPro: true,
        onboarded: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        lastSignInAt: "2026-08-30T00:00:00.000Z",
        subscriptionStatus: "active",
        amount: 3_000,
        currency: "USD",
        planId: "creator",
      },
    ],
    recentBillingEvents: [
      {
        webhook_id: "private-webhook-id",
        event_type: "subscription.updated",
        user_id: "private-billing-user",
        status: "processed",
        attempts: 1,
        error_message: "Bearer private-secret for billing@example.com",
        occurred_at: "2026-08-30T00:00:00.000Z",
        created_at: "2026-08-30T00:00:00.000Z",
      },
    ],
    instagramAutoDm: {
      connections: { total: 4, healthy: 3, actionRequired: 1, reauthRequired: 1 },
      automations: { total: 3, enabled: 2 },
      runs24h: { total: 10, completed: 8, awaiting: 1, failed: 1 },
      recentFailures: [
        {
          id: "private-run-id",
          errorCode: "private-error-code",
          errorMessage: "private raw provider error",
          attempts: 2,
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    },
  } as never);
  vi.mocked(getExploreReviews).mockResolvedValue({
    queue: "pending",
    page: 1,
    pageSize: 40,
    total: 1,
    pendingCount: 1,
    items: [
      {
        userId,
        username: "safe_creator",
        displayName: "https://internal.example/private-name",
        bio: "private review notes",
        avatarUrl: "https://storage.example/private-review-avatar",
        email: "review@example.com",
        category: "creator",
        showInExplore: true,
        onboarded: true,
        noindex: false,
        cardCount: 4,
        status: "pending",
        optedInAt: "2026-08-30T00:00:00.000Z",
        reviewedAt: null,
      },
    ],
  } as never);
  vi.mocked(getComplimentaryPlanGrants).mockResolvedValue([
    {
      id: grantId,
      userId: "private-grantee-id",
      email: "grantee@example.com",
      username: "safe_creator",
      displayName: "grantee@example.com",
      planId: "creator",
      status: "active",
      grantedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2027-08-01T00:00:00.000Z",
      revokedAt: null,
      grantedByEmail: "founder@example.com",
      lastSignInAt: "2026-08-30T00:00:00.000Z",
      userCreatedAt: "2026-07-01T00:00:00.000Z",
      billingPlanId: "store",
      billingStatus: "active",
      effectivePlanId: "creator",
    },
  ] as never);
  vi.mocked(getFounderAffiliates).mockResolvedValue({
    settings: {
      enabled: true,
      commission_rate_bps: 2_000,
      attribution_window_days: 30,
      commission_hold_days: 14,
      payout_minimums: { USD: 5_000 },
      reach_cap: 10_000,
      reach_rates: policy.reachRates,
      private_secret: "private-policy-secret",
    },
    totals: { USD: { pending: 500, available: 1_000, paid: 2_000, reversed: 0 } },
    affiliates: [
      {
        id: accountId,
        user_id: "private-affiliate-user",
        username: "safe_affiliate",
        displayName: "Bearer private-token",
        avatarUrl: "https://storage.example/private-affiliate-avatar",
        code: "SAFE20",
        status: "active",
        commission_rate_bps: null,
        clicks: 10,
        repeatClicks: 1,
        referrals: 3,
        customers: 2,
        earnings: 2_000,
        currency: "USD",
      },
    ],
    commissions: [
      { id: "private-commission", payment_id: "private-payment", provider: "private-provider" },
    ],
    payouts: [
      {
        id: payoutId,
        account_id: accountId,
        currency: "USD",
        amount: 1_000,
        status: "requested",
        requested_at: "2026-08-30T00:00:00.000Z",
        provider_reference: "private-transfer-reference",
      },
    ],
    reach: [
      {
        id: submissionId,
        account_id: accountId,
        provider: "twitter",
        canonical_post_url: "https://social.example/private-post",
        status: "review",
        final_views: 20_000,
        reward_amount: 1_000,
        currency: "USD",
        created_at: "2026-08-30T00:00:00.000Z",
        rejection_reason: "private reviewer note",
      },
    ],
    clicks: 10,
    referrals: 3,
    customers: 2,
  } as never);
}

describe("admin WebMCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers admin tools only behind the loaded admin route", () => {
    expect(adminRouteSource).toContain("useWebMcpTools(");
    expect(adminRouteSource).toContain("overview.data &&");
    expect(adminRouteSource).toContain("createAdminWebMcpTools({");
    const tools = createAdminWebMcpTools({ refresh: vi.fn() });
    expect(tools.map(({ name }) => name)).toEqual([
      "bento_get_admin_overview",
      "bento_get_admin_explore_reviews",
      "bento_get_admin_complimentary_plans",
      "bento_get_admin_affiliates",
      "bento_review_admin_explore_profile",
      "bento_manage_admin_complimentary_plan",
      "bento_manage_admin_affiliate_account",
      "bento_transition_admin_affiliate_payout",
      "bento_review_admin_affiliate_reach",
      "bento_update_admin_referral_policy",
    ]);
    expect(tools.filter((item) => item.annotations?.readOnlyHint)).toHaveLength(4);
  });

  it("returns bounded admin views without personal, provider, path, or private URL data", async () => {
    mockReads();
    const overview = await tool("bento_get_admin_overview").execute({}, { signal });
    const reviews = await tool("bento_get_admin_explore_reviews").execute({}, { signal });
    const grants = await tool("bento_get_admin_complimentary_plans").execute({}, { signal });
    const affiliates = await tool("bento_get_admin_affiliates").execute({}, { signal });
    const result = JSON.stringify({ overview, reviews, grants, affiliates });

    expect(overview).toMatchObject({
      structuredContent: {
        overview: {
          totals: { users: 100 },
          recentCreators: [{ username: "safe_creator", planId: "creator" }],
          analytics: { journeyCount: 1 },
        },
      },
    });
    expect(reviews).toMatchObject({
      structuredContent: { reviews: { items: [{ userId, username: "safe_creator" }] } },
    });
    expect(grants).toMatchObject({
      structuredContent: { grants: [{ id: grantId, username: "safe_creator" }] },
    });
    expect(affiliates).toMatchObject({
      structuredContent: {
        affiliates: {
          affiliates: [{ id: accountId, username: "safe_affiliate" }],
          payouts: [{ id: payoutId }],
          reach: [{ id: submissionId }],
        },
      },
    });
    expect(result).not.toMatch(
      /@example|private-|storage\.example|internal\.example|social\.example|access\/private/i,
    );
  });

  it("validates and fails closed before every admin mutation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["bento_review_admin_explore_profile", { userId, action: "approve" }],
      [
        "bento_manage_admin_complimentary_plan",
        {
          action: "grant",
          creatorEmail: "creator@example.com",
          planId: "creator",
          durationDays: 30,
        },
      ],
      ["bento_manage_admin_complimentary_plan", { action: "revoke", grantId }],
      [
        "bento_manage_admin_affiliate_account",
        { action: "set_status", accountId, status: "suspended" },
      ],
      [
        "bento_manage_admin_affiliate_account",
        { action: "set_rate", accountId, commissionRateBps: null },
      ],
      [
        "bento_transition_admin_affiliate_payout",
        { payoutId, status: "paid", reference: "transfer-secret" },
      ],
      [
        "bento_review_admin_affiliate_reach",
        { submissionId, decision: "rejected", reason: "Not eligible" },
      ],
      ["bento_update_admin_referral_policy", policy],
    ];

    for (const [name, input] of calls) {
      await expect(tool(name).execute(input, { signal })).rejects.toThrow("did not approve");
    }

    expect(reviewExploreProfile).not.toHaveBeenCalled();
    expect(grantComplimentaryPlan).not.toHaveBeenCalled();
    expect(revokeComplimentaryPlan).not.toHaveBeenCalled();
    expect(setReferralAccountStatus).not.toHaveBeenCalled();
    expect(setReferralAccountRate).not.toHaveBeenCalled();
    expect(transitionReferralPayout).not.toHaveBeenCalled();
    expect(reviewReachSubmission).not.toHaveBeenCalled();
    expect(updateReferralSettings).not.toHaveBeenCalled();
  });

  it("reuses authorized admin operations after confirmation and returns safe outcomes", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    for (const mutation of [
      reviewExploreProfile,
      grantComplimentaryPlan,
      revokeComplimentaryPlan,
      setReferralAccountStatus,
      setReferralAccountRate,
      transitionReferralPayout,
      reviewReachSubmission,
      updateReferralSettings,
    ]) {
      vi.mocked(mutation).mockResolvedValue({ success: true } as never);
    }

    const results = await Promise.all([
      tool("bento_review_admin_explore_profile", refresh).execute(
        { userId, action: "approve" },
        { signal },
      ),
      tool("bento_manage_admin_complimentary_plan", refresh).execute(
        {
          action: "grant",
          creatorEmail: "creator@example.com",
          planId: "creator",
          durationDays: 30,
        },
        { signal },
      ),
      tool("bento_manage_admin_complimentary_plan", refresh).execute(
        { action: "revoke", grantId },
        { signal },
      ),
      tool("bento_manage_admin_affiliate_account", refresh).execute(
        { action: "set_status", accountId, status: "suspended" },
        { signal },
      ),
      tool("bento_manage_admin_affiliate_account", refresh).execute(
        { action: "set_rate", accountId, commissionRateBps: null },
        { signal },
      ),
      tool("bento_transition_admin_affiliate_payout", refresh).execute(
        { payoutId, status: "paid", reference: "transfer-secret" },
        { signal },
      ),
      tool("bento_review_admin_affiliate_reach", refresh).execute(
        { submissionId, decision: "rejected", reason: "Not eligible" },
        { signal },
      ),
      tool("bento_update_admin_referral_policy", refresh).execute(policy, { signal }),
    ]);

    expect(reviewExploreProfile).toHaveBeenCalledWith({ data: { userId, action: "approve" } });
    expect(grantComplimentaryPlan).toHaveBeenCalledWith({
      data: { email: "creator@example.com", planId: "creator", durationDays: 30 },
    });
    expect(revokeComplimentaryPlan).toHaveBeenCalledWith({ data: { grantId } });
    expect(setReferralAccountStatus).toHaveBeenCalledWith({
      data: { accountId, status: "suspended" },
    });
    expect(setReferralAccountRate).toHaveBeenCalledWith({
      data: { accountId, commissionRateBps: null },
    });
    expect(transitionReferralPayout).toHaveBeenCalledWith({
      data: { payoutId, status: "paid", reference: "transfer-secret" },
    });
    expect(reviewReachSubmission).toHaveBeenCalledWith({
      data: { submissionId, decision: "rejected", reason: "Not eligible" },
    });
    expect(updateReferralSettings).toHaveBeenCalledWith({ data: policy });
    expect(refresh).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(results)).not.toMatch(/creator@example|transfer-secret/);
  });
});
