import { requirePlanEntitlement } from "./plan.server";

export function requireContentWorkspace(userId: string) {
  return requirePlanEntitlement(
    userId,
    "postScheduler",
    "Content is included in the Creator plan. Upgrade to continue.",
  );
}
