const UPGRADE_PROMPT_PREFIX = "bento:post-onboarding-upgrade";

type PromptStorage = Pick<Storage, "getItem" | "setItem">;

export function markPostOnboardingUpgradePending(storage: PromptStorage, profileId: string) {
  storage.setItem(`${UPGRADE_PROMPT_PREFIX}:${profileId}`, "pending");
}

export function consumePostOnboardingUpgradePrompt(
  storage: PromptStorage,
  profileId: string,
): boolean {
  const key = `${UPGRADE_PROMPT_PREFIX}:${profileId}`;
  if (storage.getItem(key) !== "pending") return false;
  storage.setItem(key, "shown");
  return true;
}
