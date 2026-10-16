import { describe, expect, it } from "vitest";
import {
  firstOfferAvailable,
  selectCancellationOffer,
  type CancellationReason,
} from "./cancellation-policy";

const active: {
  status: string;
  plan_id: string;
  billing_interval: string | null;
  pending_plan_id: string | null;
} = {
  status: "active",
  plan_id: "store",
  billing_interval: "month",
  pending_plan_id: null,
};
const engaged = { activeIntegrations: 3, hasSocial: true, activeUsage: true };

function offer(
  reason: CancellationReason | null,
  overrides: {
    subscription?: Partial<typeof active>;
    signals?: Partial<typeof engaged>;
    discountConfigured?: boolean;
  } = {},
) {
  return selectCancellationOffer({
    reason,
    subscription: { ...active, ...overrides.subscription },
    signals: { ...engaged, ...overrides.signals },
    discountConfigured: overrides.discountConfigured ?? false,
  });
}

describe("cancellation offer selection", () => {
  it("allows one offer opportunity across attempts, customers, and legacy redemptions", () => {
    expect(
      firstOfferAvailable({
        ownerHasAttempt: false,
        customerHasAttempt: false,
        legacyOfferRedeemed: false,
      }),
    ).toBe(true);
    expect(
      firstOfferAvailable({
        ownerHasAttempt: true,
        customerHasAttempt: false,
        legacyOfferRedeemed: false,
      }),
    ).toBe(false);
    expect(
      firstOfferAvailable({
        ownerHasAttempt: false,
        customerHasAttempt: true,
        legacyOfferRedeemed: false,
      }),
    ).toBe(false);
    expect(
      firstOfferAvailable({
        ownerHasAttempt: false,
        customerHasAttempt: false,
        legacyOfferRedeemed: true,
      }),
    ).toBe(false);
  });
  it("extends only an engaged trial with three distinct integrations including social", () => {
    const subscription = { status: "trialing" };
    expect(offer("break", { subscription })).toBe("trial_extension");
    expect(offer("break", { subscription, signals: { activeIntegrations: 2 } })).toBeNull();
    expect(offer("break", { subscription, signals: { hasSocial: false } })).toBeNull();
    expect(offer("break", { subscription, signals: { activeUsage: false } })).toBeNull();
  });

  it("matches budget to a lower paid plan before a discount", () => {
    expect(
      offer("budget", { subscription: { plan_id: "creator" }, discountConfigured: true }),
    ).toBe("downgrade");
    expect(offer("budget", { discountConfigured: true })).toBe("discount");
    expect(
      offer("budget", { subscription: { billing_interval: "Month" }, discountConfigured: true }),
    ).toBe("discount");
    expect(
      offer("budget", { subscription: { billing_interval: "year" }, discountConfigured: true }),
    ).toBeNull();
    expect(offer("budget")).toBeNull();
  });

  it("offers a break only without a pending plan change, while switchers can leave directly", () => {
    expect(offer("break")).toBe("pause");
    expect(offer("break", { subscription: { pending_plan_id: "creator" } })).toBeNull();
    expect(offer("moving_elsewhere")).toBeNull();
    expect(offer(null)).toBeNull();
  });
});
