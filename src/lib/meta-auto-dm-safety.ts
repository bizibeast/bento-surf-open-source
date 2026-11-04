const reasons: Record<string, string> = {
  recipient_preference_updated: "Recipient preference updated.",
  recipient_opted_out: "Recipient opted out of automated DMs.",
  recipient_cooldown:
    "A private reply was already reserved for this person and campaign in the last 24 hours.",
  account_budget: "Account safety send budget reached. This reply was not sent.",
  account_paused: "Automated sends are paused after provider rejections or rising opt-outs.",
  recipient_missing: "Meta did not provide a recipient identity needed for safe delivery.",
};

export const META_DM_SAFETY_CODES = Object.keys(reasons);

export function metaDmSafetyReason(code: string | null | undefined) {
  return code ? reasons[code] || null : null;
}
