import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dodo } from "@/integrations/dodo/client.server";
import { readBillingLifecycle } from "./billing-lifecycle";
import { isSelfHostedEdition } from "./plan.server";
import { deleteCloudflareHostname } from "./cloudflare-custom-hostnames.server";
import { deleteWorkspaceMedia } from "./workspace-media-cleanup.server";
import { lifecycleNoticeKey } from "./billing-notices.server";

/** No destructive operation starts until payment and notice prerequisites are verified. */
export async function processWorkspaceRetention(workspaceId: string) {
  if (isSelfHostedEdition()) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Service-only recovery tables are migrated separately.
  const db = supabaseAdmin as any;
  const { refreshWorkspaceSubscription } = await import("@/integrations/dodo/webhook.server");
  const { data: initial, error: initialError } = await db
    .from("profiles")
    .select("billing_lifecycle")
    .eq("id", workspaceId)
    .maybeSingle();
  if (initialError) throw new Error("Workspace retention could not be verified.");
  const candidate = readBillingLifecycle(initial?.billing_lifecycle);
  if (!candidate || candidate.reason === "paused" || Date.parse(candidate.deleteAfter) > Date.now())
    return false;
  const { data: checkouts, error: checkoutError } = await db
    .from("workspace_recovery_checkouts")
    .select("session_id,created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", candidate.stoppedAt);
  if (checkoutError) throw new Error("Recovery checkouts could not be verified.");
  for (const checkout of checkouts ?? []) {
    if (Date.parse(checkout.created_at) > Date.now() - 25 * 60 * 60 * 1000) return false;
    if (!checkout.session_id) return false; // Uncertain creation needs provider reconciliation.
    const session = await dodo.checkoutSessions.retrieve(checkout.session_id);
    if (session.id !== checkout.session_id) throw new Error("Recovery checkout identity mismatch.");
    if (session.payment_status === "succeeded") {
      if (!session.payment_id) return false;
      const payment = await dodo.payments.retrieve(session.payment_id);
      if (
        !payment.subscription_id ||
        (payment.metadata.workspace_id ?? payment.metadata.user_id) !== workspaceId
      )
        return false;
      await refreshWorkspaceSubscription(workspaceId, payment.subscription_id);
      return false;
    }
    if (session.payment_id && !["failed", "cancelled"].includes(session.payment_status ?? ""))
      return false;
    if (
      !Number.isFinite(Date.parse(session.created_at)) ||
      Date.parse(session.created_at) > Date.now() - 25 * 60 * 60 * 1000
    )
      return false;
  }
  // This verifies provider identity/product/owner and catches recovery before cleanup.
  await refreshWorkspaceSubscription(workspaceId, candidate.subscriptionId);
  const [
    { data: profile, error },
    { data: grant, error: grantError },
    { data: warning, error: warningError },
  ] = await Promise.all([
    db.from("profiles").select("billing_lifecycle").eq("id", workspaceId).maybeSingle(),
    db
      .from("complimentary_plan_grants")
      .select("id")
      .eq("user_id", workspaceId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(),
    db
      .from("email_outbox")
      .select("delivered_at,bounced_at,complained_at,status")
      .eq(
        "event_key",
        `billing-email:${lifecycleNoticeKey(workspaceId, candidate.episodeId, "workspace_deletion_warning")}`,
      )
      .maybeSingle(),
  ]);
  if (error || grantError || warningError)
    throw new Error("Workspace retention could not be verified.");
  const lifecycle = readBillingLifecycle(profile?.billing_lifecycle);
  const warningDeliveredAt = Date.parse(warning?.delivered_at ?? "");
  if (
    grant ||
    !lifecycle ||
    lifecycle.reason === "paused" ||
    lifecycle.episodeId !== candidate.episodeId ||
    Date.parse(lifecycle.deleteAfter) > Date.now() ||
    warning?.status !== "sent" ||
    warning.bounced_at != null ||
    warning.complained_at != null ||
    !Number.isFinite(warningDeliveredAt) ||
    warningDeliveredAt > Date.now() - 7 * 86_400_000
  )
    return false;
  const remote = await dodo.subscriptions.retrieve(lifecycle.subscriptionId);
  const next = Date.parse(remote.next_billing_date);
  if (remote.status === "active" && (!Number.isFinite(next) || next > Date.now())) return false;
  if (!["active", "on_hold", "failed", "cancelled", "expired"].includes(remote.status))
    return false;
  if (!["cancelled", "expired"].includes(remote.status)) {
    await dodo.subscriptions.update(lifecycle.subscriptionId, {
      status: "cancelled",
      cancel_reason: "cancelled_by_merchant",
    });
  }
  // Never rely on an update response alone, or on an old cancellation webhook.
  await refreshWorkspaceSubscription(workspaceId, lifecycle.subscriptionId);
  const confirmed = await dodo.subscriptions.retrieve(lifecycle.subscriptionId);
  if (!["cancelled", "expired"].includes(confirmed.status)) return false;
  const { data: claim, error: claimError } = await db.rpc("claim_workspace_retention", {
    p_workspace_id: workspaceId,
    p_episode_id: lifecycle.episodeId,
  });
  if (claimError) throw new Error("Workspace cleanup could not be claimed.");
  if (!claim) return false;
  const { data: domain, error: domainError } = await db
    .from("custom_domains")
    .select("cloudflare_hostname_id")
    .eq("user_id", workspaceId)
    .maybeSingle();
  if (domainError) throw new Error("Workspace domain could not be checked.");
  if (domain?.cloudflare_hostname_id) await deleteCloudflareHostname(domain.cloudflare_hostname_id);
  await deleteWorkspaceMedia(workspaceId);
  const { data: deleted, error: deleteError } = await db.rpc("finish_workspace_retention", {
    p_episode_id: lifecycle.episodeId,
    p_lease_key: claim.leaseKey,
  });
  if (deleteError) throw new Error("Workspace cleanup needs another attempt.");
  return deleted === true;
}
