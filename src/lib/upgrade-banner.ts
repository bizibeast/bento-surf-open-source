import { normalizePlan } from "./plans";

const DISMISS_PREFIX = "bento:upgrade-banner-dismissed:v1";
/** A dismissal is remembered for this long, then the banner may return once. */
export const UPGRADE_BANNER_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

type BannerStorage = Pick<Storage, "getItem" | "setItem">;

export function upgradeBannerKey(profileId: string) {
  return `${DISMISS_PREFIX}:${profileId}`;
}

export function isUpgradeBannerDismissed(
  storage: BannerStorage,
  profileId: string,
  now = Date.now(),
) {
  try {
    const value = Number(storage.getItem(upgradeBannerKey(profileId)));
    return Number.isFinite(value) && value > 0 && now - value < UPGRADE_BANNER_SNOOZE_MS;
  } catch {
    // Private mode or blocked storage: treat as not dismissed for this view only.
    return false;
  }
}

export function dismissUpgradeBanner(storage: BannerStorage, profileId: string, now = Date.now()) {
  try {
    storage.setItem(upgradeBannerKey(profileId), String(now));
  } catch {
    // Dismissal still applies for the current view.
  }
}

/**
 * Only free hosted workspaces see the banner. Paid and trialing workspaces resolve to a paid
 * plan id on the server, so they never qualify.
 */
export function shouldShowUpgradeBanner(input: {
  planId: unknown;
  isPro?: boolean | null;
  selfHosted?: boolean;
}) {
  if (input.selfHosted) return false;
  return normalizePlan(input.planId, Boolean(input.isPro)) === "free";
}
