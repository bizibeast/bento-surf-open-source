import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const creatorId = "33333333-3333-4333-8333-333333333333";
  const productId = "55555555-5555-4555-8555-555555555555";
  const leadId = "66666666-6666-4666-8666-666666666666";
  const capacityError = {
    code: "P0001",
    message:
      "Email marketing contact allowance reached. Upgrade capacity or archive subscribed contacts.",
    details: JSON.stringify({ creator_id: creatorId, subscribed: 501, limit: 500 }),
  };
  const actions: Array<{ table: string; action: string; value?: unknown }> = [];
  const from = vi.fn((table: string) => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      upsert: vi.fn((value: unknown) => {
        actions.push({ table, action: "upsert", value });
        return query;
      }),
      insert: vi.fn((value: unknown) => {
        actions.push({ table, action: "insert", value });
        return query;
      }),
      maybeSingle: vi.fn().mockResolvedValue({
        data:
          table === "commerce_products"
            ? {
                id: productId,
                creator_id: creatorId,
                kind: "lead_form",
                slug: "waitlist",
                title: "Waitlist",
                status: "published",
                settings: { fields: [], confirmationMessage: "You're in." },
              }
            : null,
        error: null,
      }),
      single: vi.fn().mockResolvedValue({ data: { id: leadId }, error: null }),
      then: (
        resolve: (value: { data: null; error: typeof capacityError | null }) => unknown,
        reject: (reason: unknown) => unknown,
      ) =>
        Promise.resolve({
          data: null,
          error: table === "audience_consent_events" ? capacityError : null,
        }).then(resolve, reject),
    };
    return query;
  });
  return {
    creatorId,
    productId,
    leadId,
    capacityError,
    actions,
    from,
    rpc: vi.fn().mockResolvedValue({
      data: "77777777-7777-4777-8777-777777777777",
      error: null,
    }),
    enqueueCreatorLeadEmail: vi.fn().mockResolvedValue(undefined),
    recordEmailMarketingCapacityBlock: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (next: typeof validate) => {
        validate = next;
        return builder;
      },
      handler:
        (handler: (input: { data: never; context: Record<string, unknown> }) => unknown) =>
        (input?: { data?: unknown }) =>
          handler({ data: validate(input?.data) as never, context: {} }),
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./email.server", () => ({
  enqueueBookingCancellationEmails: vi.fn(),
  enqueueBookingConfirmationEmails: vi.fn(),
  enqueueCommerceOrderEmails: vi.fn(),
  enqueueCreatorLeadEmail: mocks.enqueueCreatorLeadEmail,
  recordEmailMarketingCapacityBlock: mocks.recordEmailMarketingCapacityBlock,
}));
vi.mock("./plan.server", () => ({
  getPlan: vi.fn().mockResolvedValue("store"),
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("./payment-connection-policy.server", () => ({
  creatorStorePaymentSetup: vi.fn(),
  requireCreatorStorePaymentSetup: vi.fn(),
  requireReadyCreatorPaymentProvider: vi.fn(),
}));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: vi.fn().mockResolvedValue(undefined),
}));

import { submitCommerceLead } from "./commerce.functions";

describe("commerce lead contact capacity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.actions.length = 0;
    mocks.rpc.mockResolvedValue({
      data: "77777777-7777-4777-8777-777777777777",
      error: null,
    });
  });

  it("keeps the lead durable and records a privacy-safe consent capacity block", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      submitCommerceLead({
        data: {
          productId: mocks.productId,
          email: "reader@example.com",
          name: "Reader",
          answers: {},
          marketingConsent: true,
        },
      }),
    ).resolves.toEqual({ ok: true, message: "You're in." });
    expect(mocks.actions).toContainEqual(
      expect.objectContaining({ table: "commerce_leads", action: "upsert" }),
    );
    expect(mocks.recordEmailMarketingCapacityBlock).toHaveBeenCalledWith({
      creatorId: mocks.creatorId,
      source: "lead_form_consent",
      error: mocks.capacityError,
    });
    expect(mocks.enqueueCreatorLeadEmail).toHaveBeenCalledWith(
      expect.objectContaining({ leadKey: mocks.leadId, creatorId: mocks.creatorId }),
    );

    consoleError.mockRestore();
  });
});
