import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  dueLifecycleNotices,
  readBillingLifecycle,
  type BillingLifecycleNotice,
} from "./billing-lifecycle";
import { isSelfHostedEdition } from "./plan.server";
import { enqueueBentoBillingEmail } from "./email.server";

export const LIFECYCLE_NOTICE_TYPES: BillingLifecycleNotice[] = [
  "billing_access_ending",
  "billing_tools_paused",
  "billing_page_paused",
  "workspace_deletion_warning",
  "workspace_deletion_final",
];
export function lifecycleNoticeKey(
  workspaceId: string,
  episodeId: string,
  type: BillingLifecycleNotice,
) {
  return `workspace-lifecycle:${workspaceId}:${episodeId}:${type}`;
}

export async function readLifecycleNotice(
  workspaceId: string,
  episodeId: string,
  type: BillingLifecycleNotice,
) {
  if (isSelfHostedEdition()) return null;
  const { data: before, error: beforeError } = await supabaseAdmin
    .from("profiles")
    .select("billing_lifecycle")
    .eq("id", workspaceId)
    .maybeSingle();
  if (beforeError) throw new Error("Billing notice could not be verified.");
  const previous = readBillingLifecycle(before?.billing_lifecycle);
  if (!previous || previous.reason === "paused" || previous.episodeId !== episodeId) return null;
  const { refreshWorkspaceSubscription } = await import("@/integrations/dodo/webhook.server");
  await refreshWorkspaceSubscription(workspaceId, previous.subscriptionId);
  if (type === "workspace_deletion_warning") {
    const { error } = await supabaseAdmin.rpc(
      "ensure_workspace_deletion_notice_window" as never,
      { p_workspace_id: workspaceId, p_episode_id: episodeId } as never,
    );
    if (error) throw new Error("The deletion notice period could not be saved.");
  }
  const [{ data: profile, error }, { data: grant, error: grantError }] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("billing_lifecycle,display_name")
      .eq("id", workspaceId)
      .maybeSingle(),
    supabaseAdmin
      .from("complimentary_plan_grants")
      .select("id")
      .eq("user_id", workspaceId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(),
  ]);
  if (error || grantError) throw new Error("Billing notice could not be verified.");
  const lifecycle = readBillingLifecycle(profile?.billing_lifecycle);
  // The database may be slightly ahead when it extends a late warning to seven
  // full days. Delivery must not suppress that warning because of clock skew.
  const noticeTime = Date.now() + (type === "workspace_deletion_warning" ? 60_000 : 0);
  if (
    grant ||
    !lifecycle ||
    lifecycle.reason === "paused" ||
    lifecycle.episodeId !== episodeId ||
    !dueLifecycleNotices(lifecycle, noticeTime).includes(type)
  )
    return null;
  const date = (value: string) =>
    new Intl.DateTimeFormat("en", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC";
  return {
    episodeId,
    subscriptionId: lifecycle.subscriptionId,
    reason: lifecycle.reason,
    workspaceName: profile?.display_name || "your workspace",
    toolsDate: date(lifecycle.toolsStopAt),
    publicDate: date(lifecycle.publicStopAt),
    deletionDate: date(lifecycle.deleteAfter),
  };
}

export async function enqueueWorkspaceLifecycleNotices(workspaceId: string, raw: unknown) {
  const lifecycle = readBillingLifecycle(raw);
  if (!lifecycle || lifecycle.reason === "paused" || isSelfHostedEdition()) return 0;
  let queued = 0;
  for (const type of dueLifecycleNotices(lifecycle)) {
    const eventKey = lifecycleNoticeKey(workspaceId, lifecycle.episodeId, type);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Service-only email outbox is migrated separately.
    const { data: existing, error } = await (supabaseAdmin as any)
      .from("email_outbox")
      .select("id")
      .eq("event_key", `billing-email:${eventKey}`)
      .maybeSingle();
    if (error) throw new Error("Billing notice history could not be loaded.");
    if (existing) continue;
    const payload = await readLifecycleNotice(workspaceId, lifecycle.episodeId, type);
    if (!payload) continue;
    if (await enqueueBentoBillingEmail({ userId: workspaceId, eventKey, eventType: type, payload }))
      queued++;
  }
  return queued;
}
