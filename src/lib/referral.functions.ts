import { configuredPublicOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Referral tables ship with the paired migration. */
import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getCookie, getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { captureServerEvent } from "./posthog.server";
import { REFERRAL_COOKIE, referralCookieSettings, referralTokenHash } from "./referral.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { canonicalReachPostUrl, isReferralCode, reachPostFromUrl } from "./referrals";
import type { ReferralQueueMessage } from "./referral-worker.server";

const codeSchema = z
  .string()
  .trim()
  .max(32)
  .refine(isReferralCode, "Use 3–32 lowercase letters, numbers, or hyphens.");
const payoutSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
});
const reachSchema = z.object({
  postUrl: z.string().trim().url().max(2_048),
});

function publicUrl() {
  return configuredPublicOrigin(process.env.VITE_PUBLIC_URL);
}

function defaultCode(username: string, userId: string) {
  const base = username
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 22);
  const candidate = `${base || "creator"}-${userId.replaceAll("-", "").slice(0, 6)}`;
  return isReferralCode(candidate)
    ? candidate
    : `creator-${userId.replaceAll("-", "").slice(0, 12)}`;
}

export async function ensureReferralAccount(userId: string) {
  const db = supabaseAdmin as any;
  const { data: existing, error: existingError } = await db
    .from("referral_accounts")
    .select("id, user_id, code, status, commission_rate_bps, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throw new Error("Earn account could not be loaded.");
  if (existing) return existing;
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("username")
    .eq("id", userId)
    .single();
  if (profileError) throw new Error("Creator profile could not be loaded.");
  const { data, error } = await db
    .from("referral_accounts")
    .insert({ user_id: userId, code: defaultCode(profile.username, userId) })
    .select("id, user_id, code, status, commission_rate_bps, created_at")
    .single();
  if (error?.code === "23505") {
    const { data: racedAccount, error: racedError } = await db
      .from("referral_accounts")
      .select("id, user_id, code, status, commission_rate_bps, created_at")
      .eq("user_id", userId)
      .single();
    if (!racedError) return racedAccount;
  }
  if (error) throw new Error("Earn account could not be created.");
  return data;
}

export const consumeReferralAttribution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const token = getCookie(REFERRAL_COOKIE);
    const production = getRequest()?.url.startsWith("https://") ?? true;
    const clearCookie = () =>
      deleteCookie(
        REFERRAL_COOKIE,
        referralCookieSettings(production, process.env.REFERRAL_COOKIE_DOMAIN),
      );
    if (!token || !/^[A-Za-z0-9_-]{40,80}$/.test(token)) {
      clearCookie();
      return { attributed: false };
    }
    const { data, error } = await (supabaseAdmin as any).rpc("consume_referral_click", {
      p_token_hash: await referralTokenHash(token),
      p_referred_user_id: context.userId,
    });
    if (error) throw new Error("Referral attribution could not be saved.");
    clearCookie();
    if (data) void captureServerEvent(context.userId, "referral_attribution_created", {});
    return { attributed: Boolean(data) };
  });

export const getEarnOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const account = await ensureReferralAccount(context.userId);
    const db = supabaseAdmin as any;
    const [clicks, attributions, paying, commissionResult, adjustments, payouts, reach, settings] =
      await Promise.all([
        db
          .from("referral_clicks")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.id),
        db
          .from("referral_attributions")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.id),
        db
          .from("referral_attributions")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.id)
          .not("first_paid_at", "is", null),
        db
          .from("referral_commissions")
          .select(
            "id, attribution_id, currency, amount, reversed_amount, status, available_at, created_at, attribution:referral_attributions!inner(account_id)",
          )
          .eq("attribution.account_id", account.id)
          .order("created_at", { ascending: false })
          .limit(1000),
        db
          .from("referral_commission_adjustments")
          .select(
            "amount,currency,payout_id,offset_required,commission:referral_commissions!inner(attribution:referral_attributions!inner(account_id))",
          )
          .eq("commission.attribution.account_id", account.id)
          .eq("offset_required", true)
          .is("payout_id", null)
          .limit(1000),
        db
          .from("referral_payouts")
          .select("id, currency, amount, status, requested_at, paid_at")
          .eq("account_id", account.id)
          .order("requested_at", { ascending: false })
          .limit(50),
        db
          .from("referral_reach_submissions")
          .select(
            "id, provider, canonical_post_url, status, final_views, reward_amount, currency, created_at, rejection_reason",
          )
          .eq("account_id", account.id)
          .order("created_at", { ascending: false })
          .limit(50),
        db
          .from("referral_program_settings")
          .select("commission_rate_bps, payout_minimums, reach_rates, reach_cap")
          .eq("id", true)
          .single(),
      ]);
    for (const result of [
      clicks,
      attributions,
      paying,
      commissionResult,
      adjustments,
      payouts,
      reach,
      settings,
    ]) {
      if (result.error) throw new Error("Earn overview could not be loaded.");
    }
    const now = Date.now();
    const totals: Record<
      string,
      { pending: number; available: number; paid: number; lifetime: number }
    > = {};
    for (const row of commissionResult.data ?? []) {
      const value = Math.max(0, row.amount - row.reversed_amount);
      const bucket = (totals[row.currency] ??= { pending: 0, available: 0, paid: 0, lifetime: 0 });
      bucket.lifetime += value;
      if (
        row.status === "available" ||
        (row.status === "pending" && Date.parse(row.available_at) <= now)
      )
        bucket.available += value;
      else if (row.status !== "reversed" && row.status !== "paid") bucket.pending += value;
    }
    for (const row of adjustments.data ?? []) {
      const bucket = (totals[row.currency] ??= { pending: 0, available: 0, paid: 0, lifetime: 0 });
      bucket.available -= row.amount;
    }
    for (const row of reach.data ?? []) {
      if (!row.reward_amount) continue;
      const bucket = (totals[row.currency] ??= { pending: 0, available: 0, paid: 0, lifetime: 0 });
      bucket.lifetime += row.reward_amount;
      if (row.status === "approved") bucket.available += row.reward_amount;
      else if (row.status === "included_in_payout") bucket.pending += row.reward_amount;
    }
    for (const row of payouts.data ?? []) {
      if (row.status !== "paid") continue;
      const bucket = (totals[row.currency] ??= { pending: 0, available: 0, paid: 0, lifetime: 0 });
      bucket.paid += row.amount;
    }
    for (const bucket of Object.values(totals)) {
      bucket.available = Math.max(0, bucket.available);
    }
    return {
      account,
      referralUrl: `${publicUrl()}/r/${account.code}`,
      clicks: clicks.count ?? 0,
      referrals: attributions.count ?? 0,
      payingCustomers: paying.count ?? 0,
      totals,
      commissions: commissionResult.data ?? [],
      payouts: payouts.data ?? [],
      reach: reach.data ?? [],
      settings: settings.data,
    };
  });

export const updateReferralCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ code: codeSchema }).parse(input))
  .handler(async ({ context, data }) => {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "referral-code", context.userId);
    await ensureReferralAccount(context.userId);
    const { data: account, error } = await (supabaseAdmin as any)
      .from("referral_accounts")
      .update({ code: data.code })
      .eq("user_id", context.userId)
      .eq("status", "active")
      .select("code")
      .maybeSingle();
    if (error?.code === "23505") throw new Error("That referral code is already taken.");
    if (error || !account) throw new Error("Referral code could not be updated.");
    return { code: account.code, referralUrl: `${publicUrl()}/r/${account.code}` };
  });

export const requestReferralPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => payoutSchema.parse(input))
  .handler(async ({ context, data }) => {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "referral-payout", context.userId);
    const { data: payoutId, error } = await (supabaseAdmin as any).rpc("request_referral_payout", {
      p_user_id: context.userId,
      p_currency: data.currency,
    });
    if (error) {
      if (error.message?.includes("Minimum payout"))
        throw new Error("Your available balance has not reached the payout minimum yet.");
      throw new Error("Payout request could not be created.");
    }
    void captureServerEvent(context.userId, "referral_payout_requested", {
      currency: data.currency,
    });
    return { payoutId };
  });

export const submitReachReward = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reachSchema.parse(input))
  .handler(async ({ context, data }) => {
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "referral-reach", context.userId);
    const account = await ensureReferralAccount(context.userId);
    const db = supabaseAdmin as any;
    const post = reachPostFromUrl(data.postUrl);
    if (!post) throw new Error("Paste a published Instagram, Threads, LinkedIn, or X post URL.");
    const [connectionsResult, settingsResult] = await Promise.all([
      db
        .from("social_connections")
        .select("id")
        .eq("user_id", context.userId)
        .eq("provider", post.provider)
        .eq("status", "active"),
      db
        .from("referral_program_settings")
        .select("enabled,reach_rates,reach_cap")
        .eq("id", true)
        .single(),
    ]);
    if (account.status !== "active" || !settingsResult.data?.enabled)
      throw new Error("The Earn program is not available for this account.");
    if (connectionsResult.error || settingsResult.error)
      throw new Error("Reach reward settings could not be loaded.");
    const settings = settingsResult.data;
    const connectionIds = (connectionsResult.data ?? []).map((item: any) => item.id);
    const contentResult = connectionIds.length
      ? await db
          .from("social_content_insights")
          .select("connection_id, remote_post_url, caption, impressions, reach")
          .in("connection_id", connectionIds)
          .order("published_at", { ascending: false })
          .limit(1000)
      : { data: [], error: null };
    if (contentResult.error) throw new Error("Imported post metrics could not be loaded.");
    const content = (contentResult.data ?? []).find(
      (row: any) =>
        row.remote_post_url &&
        canonicalReachPostUrl(row.remote_post_url, post.provider) === post.canonicalUrl,
    );
    const views = Math.max(Number(content?.reach ?? 0), Number(content?.impressions ?? 0));
    const referralUrl = `${publicUrl()}/r/${account.code}`;
    const linked = typeof content?.caption === "string" && content.caption.includes(referralUrl);
    const rate = Number(settings.reach_rates?.[post.provider]);
    const cap = Number(settings.reach_cap);
    if (!Number.isInteger(rate) || rate < 0 || !Number.isInteger(cap) || cap < 0)
      throw new Error("Reach reward settings are invalid.");
    const status = content && linked ? "measuring" : "verifying";
    const { data: submission, error } = await db
      .from("referral_reach_submissions")
      .insert({
        account_id: account.id,
        connection_id: content?.connection_id ?? null,
        provider: post.provider,
        canonical_post_url: post.canonicalUrl,
        referral_url_snapshot: referralUrl,
        status,
        baseline_views: content && linked ? views : null,
        final_views: null,
        reward_amount: null,
        rate_per_10k: rate,
        reward_cap: cap,
        measure_after: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        provider_snapshot: {
          imported: Boolean(content),
          linked: content ? linked : null,
          manualVerification: !content,
        },
        rejection_reason: null,
      })
      .select("id, status")
      .single();
    if (error?.code === "23505") throw new Error("That post has already been submitted.");
    if (error) throw new Error("Reach reward could not be submitted.");
    const queue = (
      globalThis.__env__ as { REFERRAL_QUEUE?: Queue<ReferralQueueMessage> } | undefined
    )?.REFERRAL_QUEUE;
    if (queue && content?.connection_id) {
      await queue.send({ kind: "referral_reach_verify", submissionId: submission.id });
    }
    void captureServerEvent(context.userId, "referral_reach_post_submitted", {
      provider: post.provider,
    });
    return submission;
  });
