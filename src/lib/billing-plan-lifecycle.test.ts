import { describe, expect, it } from "vitest";
import { profilePlanForBillingSurface } from "./plan.server";
import { lifecycleDeadlines } from "./billing-lifecycle";
const now = Date.parse("2030-01-01T00:00:00Z");
function lifecycle(reason: "past_due" | "canceled", at: number) {
  return {
    episodeId: "episode",
    subscriptionId: "sub",
    reason,
    plan: "store",
    stoppedAt: new Date(at).toISOString(),
    ...lifecycleDeadlines(reason, at),
    deletingAt: null,
  };
}
describe("effective plans during retention", () => {
  it("keeps trial Plus access until a scheduled cancellation takes effect", () => {
    expect(
      profilePlanForBillingSurface(
        {
          plan_id: "store",
          trial_ends_at: new Date(now + 86_400_000).toISOString(),
          billing_lifecycle: lifecycle("canceled", now + 86_400_000),
        },
        "tools",
        now,
      ),
    ).toBe("creator_plus");
  });
  it("retains the storefront's plan for seven days but removes tools after three", () => {
    const profile = {
      plan_id: "free",
      billing_lifecycle: lifecycle("past_due", now - 4 * 86_400_000),
    };
    expect(profilePlanForBillingSurface(profile, "tools", now)).toBe("free");
    expect(profilePlanForBillingSurface(profile, "public", now)).toBe("store");
  });
});
