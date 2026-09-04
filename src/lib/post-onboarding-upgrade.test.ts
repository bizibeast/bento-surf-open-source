import { describe, expect, it } from "vitest";
import {
  consumePostOnboardingUpgradePrompt,
  markPostOnboardingUpgradePending,
} from "./post-onboarding-upgrade";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("post-onboarding upgrade prompt", () => {
  it("shows once after a creator finishes onboarding", () => {
    const storage = memoryStorage();
    markPostOnboardingUpgradePending(storage, "creator-1");

    expect(consumePostOnboardingUpgradePrompt(storage, "creator-1")).toBe(true);
    expect(consumePostOnboardingUpgradePrompt(storage, "creator-1")).toBe(false);
  });

  it("keeps prompt state isolated per creator", () => {
    const storage = memoryStorage();
    markPostOnboardingUpgradePending(storage, "creator-1");

    expect(consumePostOnboardingUpgradePrompt(storage, "creator-2")).toBe(false);
    expect(consumePostOnboardingUpgradePrompt(storage, "creator-1")).toBe(true);
  });
});
