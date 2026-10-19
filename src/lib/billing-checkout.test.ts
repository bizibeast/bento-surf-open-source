import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  preview: vi.fn(),
  product: vi.fn(),
  eligibility: vi.fn(),
  reserve: vi.fn(),
  save: vi.fn(),
  preparation: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (handler: unknown) => handler,
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      validator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler: (fn: (value: unknown) => unknown) => (input?: { data?: unknown }) =>
        fn({
          data: validate(input?.data),
          context: {
            userId: "workspace",
            authUserId: "owner",
            claims: { email: "fixture@example.com" },
          },
        }),
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: {
    checkoutSessions: { create: mocks.create, preview: mocks.preview },
    products: { retrieve: mocks.product },
  },
}));
vi.mock("./billing-checkout.server", () => ({
  checkoutEligibility: mocks.eligibility,
  reserveTrialCheckout: mocks.reserve,
  saveTrialCheckout: mocks.save,
}));
vi.mock("./billing-recovery-checkout.server", () => ({
  reserveRecoveryCheckout: vi.fn(async () => null),
  saveRecoveryCheckout: vi.fn(),
}));
vi.mock("./onboarding/session.server", () => ({ readOnboardingSession: mocks.preparation }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
import { createCheckout } from "./billing.functions";
const input = {
  plan: "creator" as const,
  period: "monthly" as const,
  returnTo: "onboarding" as const,
  contactTier: 500 as const,
  storageUnits: 0,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DODO_CREATOR_39_MONTHLY_PRODUCT_ID", "creator-39");
  vi.stubEnv("DODO_CREATOR_390_YEARLY_PRODUCT_ID", "creator-390");
  mocks.eligibility.mockResolvedValue({
    trialEligible: true,
    active: false,
    profile: { billing_catalog: "2026-10", onboarded: false },
  });
  mocks.preparation.mockResolvedValue({ status: "prepared", revision: 4, approved_revision: 4 });
  mocks.reserve.mockResolvedValue({
    url: null,
    checkoutKey: "10000000-0000-4000-8000-000000000001",
  });
  mocks.save.mockResolvedValue(undefined);
  mocks.product.mockResolvedValue({
    product_id: "creator-39",
    is_recurring: true,
    price: {
      type: "recurring_price",
      trial_amount: null,
      trial_payment_method_optional: false,
      zero_amount_payment_method_optional: false,
    },
  });
  mocks.preview.mockResolvedValue({
    current_breakup: { total_amount: 0 },
    trial_period_days: 3,
    trial_amount: null,
  });
  mocks.create.mockResolvedValue({
    session_id: "checkout-one",
    checkout_url: "https://checkout.dodopayments.com/one",
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("checkout after preparation", () => {
  it("does not send a new creator to the card form before their current preparation is approved", async () => {
    mocks.preparation.mockResolvedValueOnce({
      status: "prepared",
      revision: 5,
      approved_revision: 4,
    });
    expect(await createCheckout({ data: input })).toEqual({
      url: expect.stringContaining("/onboarding"),
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("starts three full days with a required credit card and no paid extras", async () => {
    await createCheckout({ data: input });
    expect(mocks.product).toHaveBeenCalledWith("creator-39");
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        allowed_payment_method_types: ["credit"],
        subscription_data: { trial_period_days: 3 },
        product_cart: [{ product_id: "creator-39", quantity: 1 }],
      }),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        allowed_payment_method_types: ["credit"],
        subscription_data: { trial_period_days: 3 },
        product_cart: [{ product_id: "creator-39", quantity: 1 }],
        metadata: expect.objectContaining({
          auth_user_id: "owner",
          workspace_id: "workspace",
          billing_catalog: "2026-10",
        }),
        return_url: expect.stringContaining("/onboarding?checkout=success"),
      }),
    );
    expect(mocks.save).toHaveBeenCalledWith(
      "owner",
      "checkout-one",
      "https://checkout.dodopayments.com/one",
    );
  });
  it("uses the current yearly product and records the yearly period", async () => {
    mocks.product.mockResolvedValueOnce({
      product_id: "creator-390",
      is_recurring: true,
      price: {
        type: "recurring_price",
        currency: "USD",
        price: 39000,
        payment_frequency_count: 1,
        payment_frequency_interval: "Year",
        subscription_period_count: 1,
        subscription_period_interval: "Year",
        discount: 0,
      },
    });
    await createCheckout({ data: { ...input, period: "yearly" } });
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ product_cart: [{ product_id: "creator-390", quantity: 1 }] }),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product_cart: [{ product_id: "creator-390", quantity: 1 }],
        metadata: expect.objectContaining({ period: "yearly", billing_catalog: "2026-10" }),
      }),
    );
  });
  it("blocks a yearly product with the wrong renewal amount", async () => {
    mocks.product.mockResolvedValueOnce({
      product_id: "creator-390",
      is_recurring: true,
      price: {
        type: "recurring_price",
        currency: "USD",
        price: 30000,
        payment_frequency_count: 1,
        payment_frequency_interval: "Year",
        subscription_period_count: 1,
        subscription_period_interval: "Year",
        discount: 0,
      },
    });
    await expect(createCheckout({ data: { ...input, period: "yearly" } })).rejects.toThrow(
      "trial checkout",
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("resumes the reserved provider checkout instead of creating another trial", async () => {
    mocks.reserve.mockResolvedValueOnce({
      url: "https://checkout.dodopayments.com/existing",
      checkoutKey: null,
    });
    expect(await createCheckout({ data: input })).toEqual({
      url: "https://checkout.dodopayments.com/existing",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("does not start a new subscription for an already active workspace", async () => {
    mocks.eligibility.mockResolvedValueOnce({ trialEligible: false, active: true });
    await expect(createCheckout({ data: input })).rejects.toThrow("existing subscription");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("never grants a repeated trial", async () => {
    mocks.eligibility.mockResolvedValueOnce({
      trialEligible: false,
      active: false,
      profile: { billing_catalog: "2026-10", onboarded: true },
    });
    await createCheckout({ data: input });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ subscription_data: { trial_period_days: 0 } }),
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.product).not.toHaveBeenCalled();
  });
  it.each([
    { trial_amount: 500 },
    { trial_payment_method_optional: true },
    { zero_amount_payment_method_optional: true },
  ])("blocks an unsafe trial product before reserving checkout: %j", async (price) => {
    mocks.product.mockResolvedValueOnce({
      product_id: "creator-39",
      is_recurring: true,
      price: { type: "recurring_price", ...price },
    });
    await expect(createCheckout({ data: input })).rejects.toThrow("trial checkout");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it.each([
    { current_breakup: { total_amount: 500 }, trial_period_days: 7 },
    { current_breakup: { total_amount: 0 }, trial_period_days: 0 },
    { current_breakup: { total_amount: 0 }, trial_period_days: 7, trial_amount: 500 },
    { trial_period_days: 7 },
  ])("requires a verified three-day free trial preview: %j", async (preview) => {
    mocks.preview.mockResolvedValueOnce(preview);
    await expect(createCheckout({ data: input })).rejects.toThrow("trial checkout");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("leaves checkout retryable when the provider preview is unavailable", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(createCheckout({ data: input })).rejects.toThrow("trial checkout");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rechecks provider configuration before resuming an existing checkout", async () => {
    mocks.reserve.mockResolvedValueOnce({
      url: "https://checkout.dodopayments.com/existing",
      checkoutKey: null,
    });
    mocks.preview.mockResolvedValueOnce({
      current_breakup: { total_amount: 500 },
      trial_period_days: 7,
    });
    await expect(createCheckout({ data: input })).rejects.toThrow("trial checkout");
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("accepts Dodo's documented omitted free-trial defaults", async () => {
    mocks.product.mockResolvedValueOnce({
      product_id: "creator-39",
      is_recurring: true,
      price: { type: "recurring_price" },
    });
    await expect(createCheckout({ data: input })).resolves.toEqual({
      url: "https://checkout.dodopayments.com/one",
    });
  });
  it("rejects add-ons before making a provider request", async () => {
    await expect(createCheckout({ data: { ...input, storageUnits: 1 } })).rejects.toThrow(
      "after your trial",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
