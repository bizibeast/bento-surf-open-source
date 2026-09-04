import { usernameSchema } from "./username";

export const PENDING_USERNAME_KEY = "pending_username";

export function storePendingUsername(storage: Storage, username: string) {
  const parsed = usernameSchema.safeParse(username);
  if (!parsed.success) return false;

  try {
    storage.setItem(PENDING_USERNAME_KEY, parsed.data);
    return true;
  } catch {
    return false;
  }
}

export function getPendingUsername(storage: Storage) {
  try {
    const parsed = usernameSchema.safeParse(storage.getItem(PENDING_USERNAME_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function selectOnboardingUsername(
  profileUsername: string | null | undefined,
  pendingUsername: string | null | undefined,
) {
  const pending = usernameSchema.safeParse(pendingUsername);
  if (pending.success) return pending.data;

  const profile = usernameSchema.safeParse(profileUsername);
  return profile.success ? profile.data : "";
}

export function getUsernameClaimError(error: unknown) {
  return error instanceof Error && error.message === "Username already taken"
    ? "That username was just claimed. Choose another one."
    : "Couldn’t claim that username. Please try again.";
}

export function clearPendingUsername(storage: Storage) {
  try {
    storage.removeItem(PENDING_USERNAME_KEY);
  } catch {
    // Storage may be disabled; a stale value is safer than failing a successful claim.
  }
}
