/* eslint-disable @typescript-eslint/no-explicit-any -- Referral tables ship with the paired migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertAdmin } from "./admin.functions";
import { ADMIN_DATA_ERROR } from "./admin-dashboard";

const uuid = z.string().uuid();
const db = () => supabaseAdmin as any;

async function adminRpc(name: string, args: Record<string, unknown>, knownErrors: string[] = []) {
  const { data, error } = await db().rpc(name, args);
  if (!error) return data;
  const known = knownErrors.find((message) => error.message?.includes(message));
  throw new Error(known ?? ADMIN_DATA_ERROR);
}

export const getFounderAffiliates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const [accounts, clicks, attributions, commissions, payouts, reach, settings] =
      await Promise.all([
        db()
          .from("referral_accounts")
          .select("id,user_id,code,status,commission_rate_bps,created_at,updated_at")
          .order("created_at", { ascending: false })
          .limit(1000),
        db()
          .from("referral_clicks")
          .select("account_id,visitor_hash,created_at")
          .order("created_at", { ascending: false })
          .limit(5000),
        db()
          .from("referral_attributions")
          .select("id,account_id,first_paid_at,attributed_at")
          .limit(5000),
        db()
          .from("referral_commissions")
          .select(
            "id,attribution_id,payment_id,currency,amount,reversed_amount,status,created_at,payout_id",
          )
          .order("created_at", { ascending: false })
          .limit(5000),
        db()
          .from("referral_payouts")
          .select("id,account_id,currency,amount,status,requested_at,provider_reference")
          .order("requested_at", { ascending: false })
          .limit(500),
        db()
          .from("referral_reach_submissions")
          .select(
            "id,account_id,provider,canonical_post_url,status,final_views,reward_amount,currency,created_at,rejection_reason",
          )
          .order("created_at", { ascending: false })
          .limit(500),
        db().from("referral_program_settings").select("*").eq("id", true).single(),
      ]);
    if (
      [accounts, clicks, attributions, commissions, payouts, reach, settings].some(
        (result) => result.error,
      )
    )
      throw new Error(ADMIN_DATA_ERROR);
    const userIds = (accounts.data ?? []).map((row: any) => row.user_id);
    const profiles = userIds.length
      ? await db().from("profiles").select("id,username,display_name,avatar_url").in("id", userIds)
      : { data: [], error: null };
    if (profiles.error) throw new Error(ADMIN_DATA_ERROR);
    const profilesById = new Map((profiles.data ?? []).map((row: any) => [row.id, row]));
    const attributionById = new Map<string, any>(
      (attributions.data ?? []).map((row: any) => [row.id, row]),
    );
    const seenVisitors = new Set<string>();
    const repeatClicks = new Map<string, number>();
    for (const click of clicks.data ?? []) {
      if (!click.visitor_hash) continue;
      const key = `${click.account_id}:${click.visitor_hash}`;
      if (seenVisitors.has(key))
        repeatClicks.set(click.account_id, (repeatClicks.get(click.account_id) ?? 0) + 1);
      else seenVisitors.add(key);
    }
    const totals: Record<
      string,
      { pending: number; available: number; paid: number; reversed: number }
    > = {};
    for (const item of commissions.data ?? []) {
      const bucket = (totals[item.currency] ??= { pending: 0, available: 0, paid: 0, reversed: 0 });
      bucket.reversed += item.reversed_amount;
      const net = item.amount - item.reversed_amount;
      if (item.status === "paid") bucket.paid += net;
      else if (item.status === "available") bucket.available += net;
      else if (item.status === "included_in_payout") bucket.pending += net;
      else if (item.status === "pending") bucket.pending += net;
    }
    const affiliates = (accounts.data ?? []).map((account: any) => {
      const refs = (attributions.data ?? []).filter((row: any) => row.account_id === account.id);
      const refIds = new Set(refs.map((row: any) => row.id));
      const earnings = (commissions.data ?? []).filter((row: any) =>
        refIds.has(row.attribution_id),
      );
      const profile = profilesById.get(account.user_id) as any;
      return {
        ...account,
        username: profile?.username ?? "creator",
        displayName: profile?.display_name ?? null,
        avatarUrl: profile?.avatar_url ?? null,
        clicks: (clicks.data ?? []).filter((row: any) => row.account_id === account.id).length,
        repeatClicks: repeatClicks.get(account.id) ?? 0,
        referrals: refs.length,
        customers: refs.filter((row: any) => row.first_paid_at).length,
        earnings: earnings.reduce(
          (sum: number, row: any) => sum + row.amount - row.reversed_amount,
          0,
        ),
        currency: earnings[0]?.currency ?? "USD",
      };
    });
    return {
      settings: settings.data,
      totals,
      affiliates,
      commissions: (commissions.data ?? []).map((item: any) => ({
        ...item,
        accountId: attributionById.get(item.attribution_id)?.account_id ?? null,
      })),
      payouts: payouts.data ?? [],
      reach: reach.data ?? [],
      clicks: clicks.data?.length ?? 0,
      referrals: attributions.data?.length ?? 0,
      customers: (attributions.data ?? []).filter((row: any) => row.first_paid_at).length,
    };
  });

export const setReferralAccountStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ accountId: uuid, status: z.enum(["active", "suspended"]) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    return adminRpc("admin_set_referral_account_status", {
      p_admin_user_id: context.userId,
      p_account_id: data.accountId,
      p_status: data.status,
    });
  });

export const setReferralAccountRate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ accountId: uuid, commissionRateBps: z.number().int().min(0).max(10000).nullable() })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    return adminRpc("admin_set_referral_account_rate", {
      p_admin_user_id: context.userId,
      p_account_id: data.accountId,
      p_commission_rate_bps: data.commissionRateBps,
    });
  });

export const transitionReferralPayout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        payoutId: uuid,
        status: z.enum(["approved", "processing", "paid", "rejected", "failed"]),
        reference: z.string().trim().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    return adminRpc(
      "admin_transition_referral_payout",
      {
        p_admin_user_id: context.userId,
        p_payout_id: data.payoutId,
        p_status: data.status,
        p_reference: data.reference ?? null,
      },
      ["That payout transition is not allowed", "Transfer reference is required"],
    );
  });

export const reviewReachSubmission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        submissionId: uuid,
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().trim().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    return adminRpc(
      "admin_review_referral_reach",
      {
        p_admin_user_id: context.userId,
        p_submission_id: data.submissionId,
        p_decision: data.decision,
        p_reason: data.reason ?? null,
      },
      [
        "That submission is not ready for review",
        "Verify the view count before approving this reward",
        "This referral account or program is not active",
      ],
    );
  });

export const updateReferralSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        enabled: z.boolean(),
        commissionRateBps: z.number().int().min(0).max(10000),
        attributionWindowDays: z.number().int().min(1).max(365),
        commissionHoldDays: z.number().int().min(0).max(365),
        payoutMinimumUsd: z.number().int().min(0),
        reachCap: z.number().int().min(0),
        reachRates: z.object({
          twitter: z.number().int().min(0),
          linkedin: z.number().int().min(0),
          instagram: z.number().int().min(0),
          threads: z.number().int().min(0),
        }),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.userId);
    const { data: before, error: readError } = await db()
      .from("referral_program_settings")
      .select("*")
      .eq("id", true)
      .single();
    if (readError) throw new Error(ADMIN_DATA_ERROR);
    return adminRpc("admin_update_referral_settings", {
      p_admin_user_id: context.userId,
      p_enabled: data.enabled,
      p_commission_rate_bps: data.commissionRateBps,
      p_attribution_window_days: data.attributionWindowDays,
      p_commission_hold_days: data.commissionHoldDays,
      p_payout_minimums: { ...before.payout_minimums, USD: data.payoutMinimumUsd },
      p_reach_rates: data.reachRates,
      p_reach_cap: data.reachCap,
    });
  });
