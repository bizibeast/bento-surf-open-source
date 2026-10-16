import { z } from "zod";

export const BILLING_DAY_MS = 86_400_000;
export const BILLING_RETENTION_DAYS = 90;
const timestamp = z.string().datetime({ offset: true });
const lifecycleBase = z.object({
  episodeId: z.string().min(1),
  subscriptionId: z.string().min(1),
  plan: z.enum(["store", "creator", "creator_plus"]),
  stoppedAt: timestamp,
  toolsStopAt: timestamp,
  publicStopAt: timestamp,
  deletingAt: timestamp.nullable().default(null),
});
export const billingLifecycleSchema = z.discriminatedUnion("reason", [
  lifecycleBase.extend({ reason: z.literal("past_due"), deleteAfter: timestamp }),
  lifecycleBase.extend({ reason: z.literal("canceled"), deleteAfter: timestamp }),
  lifecycleBase.extend({ reason: z.literal("expired"), deleteAfter: timestamp }),
  lifecycleBase.extend({ reason: z.literal("paused"), deleteAfter: z.null() }),
]);
export type BillingLifecycle = z.infer<typeof billingLifecycleSchema>;
export type BillingSurface = "tools" | "public";
export type BillingLifecycleNotice =
  | "billing_access_ending"
  | "billing_tools_paused"
  | "billing_page_paused"
  | "workspace_deletion_warning"
  | "workspace_deletion_final";

export function readBillingLifecycle(value: unknown): BillingLifecycle | null {
  const parsed = billingLifecycleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function lifecycleDeadlines(
  reason: Exclude<BillingLifecycle["reason"], "paused">,
  stoppedAt: number,
) {
  const at = (days: number) => new Date(stoppedAt + days * BILLING_DAY_MS).toISOString();
  return {
    toolsStopAt: at(reason === "past_due" ? 3 : 0),
    publicStopAt: at(reason === "past_due" ? 7 : 0),
    deleteAfter: at(BILLING_RETENTION_DAYS),
  };
}

export function billingAllows(value: unknown, surface: BillingSurface, now = Date.now()) {
  if (value == null) return true;
  const lifecycle = readBillingLifecycle(value);
  if (!lifecycle || lifecycle.deletingAt) return false;
  return now < Date.parse(surface === "tools" ? lifecycle.toolsStopAt : lifecycle.publicStopAt);
}

export function dueLifecycleNotices(
  lifecycle: BillingLifecycle,
  now = Date.now(),
): BillingLifecycleNotice[] {
  const notices: BillingLifecycleNotice[] = [];
  if (lifecycle.reason === "paused") return notices;
  if (Date.parse(lifecycle.stoppedAt) > now || lifecycle.deletingAt) return notices;
  notices.push("billing_access_ending");
  if (lifecycle.reason === "past_due") {
    if (Date.parse(lifecycle.toolsStopAt) <= now) notices.push("billing_tools_paused");
    if (Date.parse(lifecycle.publicStopAt) <= now) notices.push("billing_page_paused");
  }
  const deletion = Date.parse(lifecycle.deleteAfter);
  if (now >= deletion - 7 * BILLING_DAY_MS) notices.push("workspace_deletion_warning");
  if (now >= deletion - BILLING_DAY_MS) notices.push("workspace_deletion_final");
  return notices;
}
