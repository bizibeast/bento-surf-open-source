import { describe, expect, it } from "vitest";
import { profilePlanForBillingSurface } from "./plan.server";
import { lifecycleDeadlines } from "./billing-lifecycle";
import { minimumPlanForEntitlement, planHasEntitlement } from "./plans";
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
  it("keeps the subscribed plan, not Creator Plus, until a scheduled trial cancellation", () => {
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
    ).toBe("store");
  });
  it.each(["store", "creator", "creator_plus"] as const)(
    "grants exactly the %s plan during a trial",
    (plan) => {
      expect(
        profilePlanForBillingSurface(
          { plan_id: plan, is_pro: true, trial_ends_at: new Date(now + 86_400_000).toISOString() },
          "tools",
          now,
        ),
      ).toBe(plan);
    },
  );
  it("shows the normal upgrade gate for higher-plan features during a Store trial", () => {
    const plan = profilePlanForBillingSurface(
      { plan_id: "store", is_pro: true, trial_ends_at: new Date(now + 86_400_000).toISOString() },
      "tools",
      now,
    );
    expect(planHasEntitlement(plan, "brain")).toBe(false);
    expect(minimumPlanForEntitlement("brain")).toBe("creator_plus");
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
