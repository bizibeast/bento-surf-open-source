/* eslint-disable @typescript-eslint/no-explicit-any -- Network/database boundaries are isolated for checkout tests. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  product: {} as any,
  provider: "stripe",
  from: vi.fn(),
  rpc: vi.fn(),
  adapter: vi.fn(),
  customer: vi.fn(),
  followUp: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validator = (input: any) => input;
    const chain: any = {
      middleware: () => chain,
      validator: (next: any) => {
        validator = next;
        return chain;
      },
      handler:
        (fn: any) =>
        ({ data }: any) =>
          fn({ data: validator(data), context: {} }),
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: vi.fn(),
  enforceInternalJobSecret: vi.fn(),
}));
vi.mock("./plan.server", async (original) => ({
  ...(await original<typeof import("./plan.server")>()),
  getPlan: async () => "pro",
}));
vi.mock("./plans", async (original) => ({
  ...(await original<typeof import("./plans")>()),
  planHasEntitlement: () => true,
}));
vi.mock("./payment-connection-policy.server", async (original) => ({
  ...(await original<typeof import("./payment-connection-policy.server")>()),
  requireReadyCreatorPaymentProvider: vi.fn(),
}));
vi.mock("./commerce-growth.server", () => ({
  resolveCommerceCheckoutGrowth: async ({ product }: any) => ({
    primaryAmount: product.price_amount,
    subtotalAmount: product.price_amount,
    grossAmount: product.price_amount,
    discountAmount: 0,
    recordingAddonAmount: 0,
    bumpAmount: 0,
    bumpProductId: null,
    discountCodeId: null,
    attribution: {},
  }),
}));
vi.mock("./secret-crypto.server", () => ({
  encryptServerSecret: async (value: string) => value,
  decryptServerSecret: async (value: string) => value,
}));
vi.mock("./email.server", () => ({ enqueueCommerceOrderEmails: vi.fn() }));
vi.mock("./customer-library-auth.server", () => ({ currentCustomerSession: mocks.customer }));
vi.mock("./priority-dm.server", () => ({ loadPriorityDmPaidFollowUp: mocks.followUp }));
vi.mock("@/integrations/stripe/checkout.server", () => ({
  createStripeCommerceCheckout: (input: unknown) => mocks.adapter("stripe", input),
}));
vi.mock("@/integrations/paypal/checkout.server", () => ({
  createPayPalCommerceCheckout: (input: unknown) => mocks.adapter("paypal", input),
}));
vi.mock("@/integrations/razorpay/checkout.functions", () => ({
  createRazorpayCommerceCheckout: (input: unknown) => mocks.adapter("razorpay", input),
}));
vi.mock("@/integrations/polar/checkout.server", () => ({
  createPolarCommerceCheckout: (input: unknown) => mocks.adapter("polar", input),
}));
vi.mock("@/integrations/dodo/checkout.server", () => ({
  createDodoCommerceCheckout: (input: unknown) => mocks.adapter("dodo", input),
}));
vi.mock("@/integrations/creem/checkout.server", () => ({
  createCreemCommerceCheckout: (input: unknown) => mocks.adapter("creem", input),
}));

import { createCommerceCheckout, productDraftSchema } from "./commerce.functions";
import { commerceBuyerQuestions, commerceBuyerQuestionsVersion } from "./commerce-buyer-questions";
import { commerceProductPublishabilityError } from "./commerce";

const id = "11111111-1111-4111-8111-111111111111";
const question = { id, question: "What do you want to learn?", required: true };
const website = {
  sections: [{ id: "intake", title: "Before you begin", body: "", buyerQuestions: [question] }],
};
const input = () => ({
  productId: mocks.product.id,
  email: "buyer@example.com",
  answers: { [`bq_${id}`]: " Build a course " },
  buyerQuestionsVersion: commerceBuyerQuestionsVersion(
    commerceBuyerQuestions(mocks.product.settings, mocks.product.kind),
  ),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider = "stripe";
  mocks.product = {
    id: "33333333-3333-4333-8333-333333333333",
    creator_id: "44444444-4444-4444-8444-444444444444",
    kind: "course",
    status: "published",
    title: "Course",
    description: "Course",
    slug: "course",
    public_slug: "course",
    pricing_type: "one_time",
    price_amount: 1900,
    currency: "usd",
    billing_interval: null,
    cta_label: "Buy",
    sales_count: 0,
    inventory_limit: null,
    settings: { lessons: [{ id: "lesson", title: "Lesson", body: "Content" }], website },
  };
  mocks.from.mockImplementation((table) => {
    const query: any = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({
        data: table === "commerce_products" ? mocks.product : null,
        error: null,
      }),
      single: async () => ({
        data: {
          commerce_payment_provider: mocks.provider,
          username: "creator",
          page_published: true,
        },
        error: null,
      }),
    };
    return query;
  });
  mocks.rpc.mockResolvedValue({
    data: { order_id: "order-free", created_new_order: true },
    error: null,
  });
  mocks.adapter.mockResolvedValue({ url: "https://checkout.example.com" });
  mocks.customer.mockResolvedValue(null);
  mocks.followUp.mockResolvedValue({
    id: "55555555-5555-4555-8555-555555555555",
    freeFollowUpsRemaining: 0,
    followUpPriceAmount: 500,
    currency: "usd",
  });
});

describe("buyer questions at the canonical checkout boundary", () => {
  it.each(["stripe", "paypal", "razorpay", "polar", "dodo", "creem"])(
    "passes canonical labels and answers to %s fulfillment metadata",
    async (provider) => {
      mocks.provider = provider;
      await createCommerceCheckout({ data: input() });
      expect(mocks.adapter.mock.calls[0]).toMatchObject([
        provider,
        { buyerAnswers: [{ question: question.question, answer: "Build a course" }] },
      ]);
    },
  );

  it("persists the same private answers on free claims", async () => {
    mocks.product.pricing_type = "free";
    mocks.product.price_amount = 0;
    await createCommerceCheckout({ data: input() });
    const free = mocks.rpc.mock.calls.find((call) => call[0] === "claim_free_commerce_offer");
    expect(free?.[1].p_metadata.buyer_answers).toEqual([
      { question: question.question, answer: "Build a course" },
    ]);
  });

  it.each(["missing", "stale", "fabricated"])(
    "rejects %s input before creating any checkout",
    async (mode) => {
      const data: any = input();
      if (mode === "missing") data.answers = {};
      if (mode === "stale") data.buyerQuestionsVersion = "outdated";
      if (mode === "fabricated") data.answers.forged = "A fabricated prompt";
      await expect(createCommerceCheckout({ data })).rejects.toThrow(
        /answer|changed|unknown|refresh/i,
      );
      expect(mocks.adapter).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("keeps existing authenticated paid follow-ups scoped to the conversation message", async () => {
    mocks.product.kind = "priority_dm";
    mocks.product.settings.responseTimeHours = 48;
    mocks.customer.mockResolvedValue({
      customer: { email_normalized: "buyer@example.com", name: "Buyer" },
    });
    await createCommerceCheckout({
      data: {
        productId: mocks.product.id,
        priorityDmRequestId: "55555555-5555-4555-8555-555555555555",
        email: "buyer@example.com",
        answers: { priority_message: "Follow-up" },
      },
    });
    const answers = mocks.adapter.mock.calls[0][1].buyerAnswers;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      answer: "Follow-up",
      priorityDmRequestId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("enforces combined legacy and section definition limits when saving and publishing", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `Legacy ${index}`);
    const product = {
      ...mocks.product,
      kind: "custom_product" as const,
      settings: { website, buyerQuestions: twenty, fulfillmentInstructions: "Email delivery" },
    };
    expect(productDraftSchema.safeParse(product).success).toBe(false);
    expect(commerceProductPublishabilityError(product)).toMatch(/20/);
  });
});
