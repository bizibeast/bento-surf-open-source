/* eslint-disable @typescript-eslint/no-explicit-any -- Referral tables ship with the paired migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { canonicalReachPostUrl, reachRewardAmount } from "./referrals";

export type ReferralQueueMessage = { kind: "referral_reach_verify"; submissionId: string };

export async function processReferralQueueMessage(message: ReferralQueueMessage) {
  const db = supabaseAdmin as any;
  const { data: submission, error } = await db
    .from("referral_reach_submissions")
    .select(
      "id,connection_id,provider,canonical_post_url,referral_url_snapshot,status,baseline_views,measure_after,rate_per_10k,reward_cap,account:referral_accounts!inner(status)",
    )
    .eq("id", message.submissionId)
    .single();
  if (error) throw new Error("Reach submission could not be loaded.");
  if (["approved", "rejected", "included_in_payout", "paid"].includes(submission.status)) return;
  const accountStatus = Array.isArray(submission.account)
    ? submission.account[0]?.status
    : submission.account?.status;

  const contentRequest = submission.connection_id
    ? db
        .from("social_content_insights")
        .select("remote_post_url,caption,impressions,reach,fetched_at")
        .eq("connection_id", submission.connection_id)
        .order("published_at", { ascending: false })
        .limit(500)
    : Promise.resolve({ data: [], error: null });
  const [{ data: contentRows, error: contentError }, { data: settings, error: settingsError }] =
    await Promise.all([
      contentRequest,
      db.from("referral_program_settings").select("enabled").eq("id", true).single(),
    ]);
  if (contentError || settingsError) throw new Error("Imported post metrics could not be loaded.");
  if (accountStatus !== "active" || !settings?.enabled) {
    const { error: inactiveError } = await db
      .from("referral_reach_submissions")
      .update({
        status: "rejected",
        rejection_reason: "This referral account or program is not active.",
      })
      .eq("id", submission.id)
      .eq("status", submission.status);
    if (inactiveError) throw new Error("Reach submission could not be updated.");
    return;
  }
  if (!submission.connection_id) return;
  const content = (contentRows ?? []).find(
    (row: any) =>
      row.remote_post_url &&
      canonicalReachPostUrl(row.remote_post_url, submission.provider) ===
        submission.canonical_post_url,
  );
  if (!content) throw new Error("The post has not reached Social Insights yet.");

  const linked =
    typeof content.caption === "string" &&
    content.caption.includes(submission.referral_url_snapshot);
  if (!linked) {
    const { error: linkError } = await db
      .from("referral_reach_submissions")
      .update({
        status: "rejected",
        rejection_reason: "The imported post does not contain this creator's Bento referral link.",
        provider_snapshot: { imported: true, linked: false, fetchedAt: content.fetched_at },
      })
      .eq("id", submission.id)
      .eq("status", submission.status);
    if (linkError) throw new Error("Reach submission could not be updated.");
    return;
  }

  const views = Math.max(Number(content.reach ?? 0), Number(content.impressions ?? 0));
  const due = Date.parse(submission.measure_after) <= Date.now();
  const { error: updateError } = await db
    .from("referral_reach_submissions")
    .update({
      status: due ? "review" : "measuring",
      baseline_views: submission.baseline_views ?? views,
      final_views: due ? views : null,
      reward_amount: due
        ? reachRewardAmount(
            submission.provider,
            views,
            { [submission.provider]: submission.rate_per_10k },
            submission.reward_cap,
          )
        : null,
      eligible_at: new Date().toISOString(),
      provider_snapshot: { imported: true, linked: true, fetchedAt: content.fetched_at },
    })
    .eq("id", submission.id)
    .eq("status", submission.status);
  if (updateError) throw new Error("Reach submission could not be updated.");
}

export async function enqueueDueReferralReach(queue?: Queue<ReferralQueueMessage>) {
  if (!queue) return { queued: 0 };
  const { data, error } = await (supabaseAdmin as any)
    .from("referral_reach_submissions")
    .select("id")
    .in("status", ["submitted", "verifying", "measuring"])
    .not("connection_id", "is", null)
    .or(
      `status.eq.submitted,status.eq.verifying,measure_after.is.null,measure_after.lte.${new Date().toISOString()}`,
    )
    .limit(50);
  if (error) throw new Error("Due reach submissions could not be loaded.");
  await Promise.all(
    (data ?? []).map((row: any) =>
      queue.send({ kind: "referral_reach_verify", submissionId: row.id }),
    ),
  );
  return { queued: data?.length ?? 0 };
}

export async function reconcileReferralLedger() {
  const db = supabaseAdmin as any;
  // ponytail: the newest 1,000 effects cover normal daily drift; paginate if
  // reconciliation volume ever approaches that ceiling.
  const [payments, refunds] = await Promise.all([
    db
      .from("referral_payment_effects")
      .select("payment_id")
      .eq("eligible", true)
      .order("created_at", { ascending: false })
      .limit(1000),
    db
      .from("refunds")
      .select("refund_id")
      .in("status", ["succeeded", "paid", "completed"])
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  if (payments.error || refunds.error)
    throw new Error("Referral reconciliation sources could not be loaded.");
  for (const row of payments.data ?? []) {
    const { error } = await db.rpc("accrue_referral_commission", { p_payment_id: row.payment_id });
    if (error) throw new Error("Referral payment reconciliation failed.");
  }
  for (const row of refunds.data ?? []) {
    const { error } = await db.rpc("apply_referral_refund", { p_refund_id: row.refund_id });
    if (error) throw new Error("Referral refund reconciliation failed.");
  }
  return { payments: payments.data?.length ?? 0, refunds: refunds.data?.length ?? 0 };
}
