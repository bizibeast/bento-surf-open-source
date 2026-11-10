import { isDisposableOrTestEmail } from "./disposable-email";
import { normalizeEmailRecipient } from "./email-recipient";

/** Marketing onboarding steps. One send per inbox per step. */
export const LIFECYCLE_NUDGE_EVENTS = [
  "onboarding_quick_win",
  "commerce_feature",
  "pro_upgrade",
] as const;

export type LifecycleNudgeEvent = (typeof LIFECYCLE_NUDGE_EVENTS)[number];

export function isLifecycleNudgeEvent(eventType: string): eventType is LifecycleNudgeEvent {
  return (LIFECYCLE_NUDGE_EVENTS as readonly string[]).includes(eventType);
}

/**
 * Address written on the message. Plus-tags stay. Invalid, disposable, and
 * test inboxes are skipped. There is no owner or sandbox fallback.
 */
export function lifecycleNudgeRecipient(value: string) {
  const email = normalizeEmailRecipient(value);
  if (!email || isDisposableOrTestEmail(email)) return null;
  return email;
}

/**
 * Identity for "has this inbox already had this step?".
 * ponytail: Gmail and Googlemail only (dots and plus-tags). Other providers
 * keep the full address, so their plus-aliases can each receive one step.
 */
export function lifecycleNudgeInboxKey(value: string) {
  const email = normalizeEmailRecipient(value);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return email;
  const base = local.split("+")[0]?.replace(/\./g, "") ?? "";
  return base ? `${base}@gmail.com` : null;
}

/** Delivery eligibility only. Inbox dedupe is enforced by the database. */
export function lifecycleNudgeSendDecision(input: {
  recipientEmail: string;
  mode: string;
}): { action: "send"; recipient: string } | { action: "suppress"; reason: string } {
  if (input.mode === "sandbox") {
    return { action: "suppress", reason: "Lifecycle nudges are not sent in sandbox." };
  }
  const recipient = lifecycleNudgeRecipient(input.recipientEmail);
  if (!recipient) {
    return { action: "suppress", reason: "Test, disposable, or invalid inbox." };
  }
  return { action: "send", recipient };
}
