import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ insert: vi.fn(), single: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: mocks.insert,
      select: () => ({ eq: () => ({ single: mocks.single }) }),
    }),
  },
}));
import { reserveTrialCheckout } from "./billing-checkout.server";

const verified = "free-card-v1:test_mode:creator-39";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.insert.mockResolvedValue({ error: { code: "23505" } });
  mocks.single.mockResolvedValue({
    data: {
      workspace_id: "owner",
      plan_id: "creator",
      checkout_url: "https://checkout.dodopayments.com/existing",
      trial_verification_key: verified,
    },
    error: null,
  });
});

describe("verified trial reservations", () => {
  it("binds new reservations to the verified product, environment and checkout policy", async () => {
    mocks.insert.mockResolvedValueOnce({ error: null });
    await reserveTrialCheckout("owner", "owner", "creator", verified);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ trial_verification_key: verified }),
    );
  });
  it("resumes a checkout with the same verified terms", async () => {
    await expect(reserveTrialCheckout("owner", "owner", "creator", verified)).resolves.toEqual({
      url: "https://checkout.dodopayments.com/existing",
      checkoutKey: null,
    });
  });
  it.each([
    null,
    "free-card-v1:test_mode:previous-product",
    "free-card-v1:live_mode:creator-39",
    "older-policy:test_mode:creator-39",
  ])("requires reconciliation of a differently verified saved checkout: %s", async (key) => {
    mocks.single.mockResolvedValueOnce({
      data: {
        workspace_id: "owner",
        plan_id: "creator",
        checkout_url: "https://checkout.dodopayments.com/existing",
        trial_verification_key: key,
      },
      error: null,
    });
    await expect(reserveTrialCheckout("owner", "owner", "creator", verified)).rejects.toThrow(
      "previous checkout needs verification",
    );
  });
});
