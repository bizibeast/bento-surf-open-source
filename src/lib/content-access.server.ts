import { requirePlanEntitlement } from "./plan.server";
import { entitlementUpgradeMessage, type EntitlementKey } from "./plans";

export function requireContentWorkspace(userId: string, entitlement: EntitlementKey = "brain") {
  return requirePlanEntitlement(userId, entitlement, entitlementUpgradeMessage(entitlement));
}
