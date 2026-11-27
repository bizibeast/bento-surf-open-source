import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  productId: "55555555-5555-4555-8555-555555555555",
  creatorId: "33333333-3333-4333-8333-333333333333",
  published: false,
  kind: "paid_community",
  rpc: vi.fn(),
  writes: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (v: unknown) => v;
    const builder = {
      middleware: () => builder,
      validator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (v: unknown) => unknown) => (input: { data: unknown }) =>
        fn({ data: validate(input.data), context: {} }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./plan.server", () => ({
  getPlan: vi.fn().mockResolvedValue("store"),
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: state.rpc,
    from: (table: string) => {
      const data =
        table === "profiles"
          ? {
              id: state.creatorId,
              username: "creator",
              page_published: state.published,
              commerce_payment_provider: null,
            }
          : {
              id: state.productId,
              creator_id: state.creatorId,
              kind: state.kind,
              status: "published",
              title: "Community",
              description: "Published product description",
              public_slug: "community",
              pricing_type: "free",
              price_amount: 0,
              currency: "usd",
              settings: {
                fields: [],
                bundledProductIds: [
                  "11111111-1111-4111-8111-111111111111",
                  "22222222-2222-4222-8222-222222222222",
                ],
              },
              inventory_limit: null,
            };
      const included = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ].map((id) => ({
        id,
        kind: "custom_product",
        status: "published",
        settings: { buyerQuestions: ["What should I prepare?"] },
      }));
      const q = {
        in: () => q,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: included, error: null }).then(resolve),
        select: () => q,
        eq: () => q,
        single: async () => ({ data, error: null }),
        maybeSingle: async () => ({ data, error: null }),
        insert: state.writes,
        upsert: state.writes,
      };
      return q;
    },
  },
}));
import {
  createCommerceCheckout,
  previewCommerceCheckout,
  submitCommerceLead,
} from "./commerce.functions";
beforeEach(() => {
  vi.clearAllMocks();
  state.published = false;
  state.kind = "paid_community";
});
it.each([createCommerceCheckout, previewCommerceCheckout])(
  "rejects checkout for a published product after its creator unpublishes the Link page",
  async (checkout) => {
    await expect(
      checkout({
        data: { productId: state.productId, email: "buyer@example.com", answers: {} },
      } as never),
    ).rejects.toThrow(/not available/);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  },
);
it("does not capture new leads for an unpublished creator", async () => {
  state.kind = "lead_form";
  await expect(
    submitCommerceLead({
      data: { productId: state.productId, email: "reader@example.com", answers: {} },
    }),
  ).rejects.toThrow(/not available/);
  expect(state.writes).not.toHaveBeenCalled();
});

it.each([createCommerceCheckout, previewCommerceCheckout])(
  "rechecks required intake on bundle items before payment even after a child changes",
  async (checkout) => {
    state.published = true;
    state.kind = "bundle";
    await expect(
      checkout({
        data: { productId: state.productId, email: "buyer@example.com", answers: {} },
      } as never),
    ).rejects.toThrow(/Bundle items cannot require separate buyer answers/);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  },
);
