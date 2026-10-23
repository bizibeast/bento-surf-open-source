import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  single: vi.fn(),
  update: vi.fn(),
  rotated: vi.fn(),
  retrieve: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: mocks.insert,
      select: () => ({ eq: () => ({ single: mocks.single }) }),
      update: (values: unknown) => {
        mocks.update(values);
        return { eq: () => ({ eq: () => ({ select: mocks.rotated }) }) };
      },
    }),
  },
}));
vi.mock("@/integrations/dodo/client.server", () => ({
  dodo: { checkoutSessions: { retrieve: mocks.retrieve } },
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
      checkout_session_id: "cks_existing",
      trial_verification_key: verified,
      created_at: new Date().toISOString(),
    },
    error: null,
  });
  mocks.retrieve.mockResolvedValue({ id: "cks_existing", created_at: new Date().toISOString() });
  mocks.rotated.mockResolvedValue({ data: [{ checkout_key: "new" }], error: null });
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

  it.each(["failed", "cancelled"])(
    "issues a fresh checkout after Dodo reports the payment %s",
    async (status) => {
      mocks.retrieve.mockResolvedValueOnce({
        id: "cks_existing",
        created_at: new Date().toISOString(),
        payment_id: "pay_1",
        payment_status: status,
      });
      const result = await reserveTrialCheckout("owner", "owner", "store", verified);
      expect(result.url).toBeNull();
      expect(result.checkoutKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          plan_id: "store",
          checkout_key: result.checkoutKey,
          checkout_url: null,
          checkout_session_id: null,
          trial_verification_key: verified,
          trial_days: 3,
        }),
      );
    },
  );
  it("issues a fresh checkout after an unpaid session expired", async () => {
    mocks.retrieve.mockResolvedValueOnce({
      id: "cks_existing",
      created_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      payment_status: null,
    });
    await expect(reserveTrialCheckout("owner", "owner", "creator", verified)).resolves.toEqual(
      expect.objectContaining({ url: null }),
    );
  });
  it.each(["processing", "succeeded", "requires_customer_action"])(
    "keeps a %s checkout instead of opening a second trial",
    async (status) => {
      mocks.retrieve.mockResolvedValueOnce({
        id: "cks_existing",
        created_at: new Date().toISOString(),
        payment_status: status,
      });
      await expect(reserveTrialCheckout("owner", "owner", "creator", verified)).resolves.toEqual({
        url: "https://checkout.dodopayments.com/existing",
        checkoutKey: null,
      });
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
  it("keeps the saved checkout when Dodo cannot be reached", async () => {
    mocks.retrieve.mockRejectedValueOnce(new Error("network"));
    await expect(reserveTrialCheckout("owner", "owner", "creator", verified)).resolves.toEqual({
      url: "https://checkout.dodopayments.com/existing",
      checkoutKey: null,
    });
  });
  it("does not race a retry already started in another tab", async () => {
    mocks.retrieve.mockResolvedValueOnce({
      id: "cks_existing",
      created_at: new Date().toISOString(),
      payment_status: "failed",
    });
    mocks.rotated.mockResolvedValueOnce({ data: [], error: null });
    await expect(reserveTrialCheckout("owner", "owner", "creator", verified)).rejects.toThrow(
      "being prepared",
    );
  });
});
