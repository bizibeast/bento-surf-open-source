import { expect, it } from "vitest";
import {
  dismissUpgradeBanner,
  isUpgradeBannerDismissed,
  shouldShowUpgradeBanner,
  upgradeBannerKey,
  UPGRADE_BANNER_SNOOZE_MS,
} from "./upgrade-banner";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

it("shows only to free hosted workspaces", () => {
  expect(shouldShowUpgradeBanner({ planId: "free" })).toBe(true);
  expect(shouldShowUpgradeBanner({ planId: null })).toBe(true);
  // Trialing and paid workspaces resolve to their paid plan.
  for (const planId of ["store", "creator", "creator_plus", "pro", "max"])
    expect(shouldShowUpgradeBanner({ planId })).toBe(false);
  expect(shouldShowUpgradeBanner({ planId: null, isPro: true })).toBe(false);
  expect(shouldShowUpgradeBanner({ planId: "free", selfHosted: true })).toBe(false);
});

it("remembers a dismissal per workspace and snoozes it", () => {
  const storage = memory();
  const now = 1_800_000_000_000;
  expect(isUpgradeBannerDismissed(storage, "a", now)).toBe(false);
  dismissUpgradeBanner(storage, "a", now);
  expect(storage.getItem(upgradeBannerKey("a"))).toBe(String(now));
  expect(isUpgradeBannerDismissed(storage, "a", now + 1000)).toBe(true);
  expect(isUpgradeBannerDismissed(storage, "b", now + 1000)).toBe(false);
  expect(isUpgradeBannerDismissed(storage, "a", now + UPGRADE_BANNER_SNOOZE_MS + 1)).toBe(false);
});

it("treats blocked storage as not dismissed without throwing", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  expect(isUpgradeBannerDismissed(blocked, "a")).toBe(false);
  expect(() => dismissUpgradeBanner(blocked, "a")).not.toThrow();
});
