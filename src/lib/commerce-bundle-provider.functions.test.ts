/* eslint-disable @typescript-eslint/no-explicit-any -- Canonical boundaries use scoped in-memory product rows and fake adapters. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), adapter: vi.fn(), provider: "stripe" }));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (input: any) => input;
    const q: any = {
      middleware: () => q,
      validator: (next: any) => {
        validate = next;
        return q;
      },
      handler:
        (fn: any) =>
        ({ data }: any) =>
          fn({ data: validate(data), context: {} }),
    };
    return q;
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./plan.server", () => ({
  getPlan: async () => "creator",
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("./username-alias.server", () => ({
  resolvePublicUsername: async () => ({ userId: "33333333-3333-4333-8333-333333333333" }),
}));
vi.mock("./public-creator-chrome.server", () => ({
  loadPublicCreatorChrome: async () => ({ creator: { username: "creator" }, pages: [] }),
}));
vi.mock("./payment-connection-policy.server", () => ({
  creatorStorePaymentSetup: vi.fn(),
  requireCreatorStorePaymentSetup: vi.fn(),
  requireReadyCreatorPaymentProvider: vi.fn(),
}));
vi.mock("./commerce-assets.server", () => ({ verifyDigitalProductAssets: vi.fn() }));
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
import {
  createCommerceCheckout,
  previewCommerceCheckout,
  getPublicCommerceProduct,
  validateCommerceProductPublication,
} from "./commerce.functions";
const creatorId = "33333333-3333-4333-8333-333333333333";
const productId = "55555555-5555-4555-8555-555555555555";
const childIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
let products: any[];
function query(table: string) {
  const predicates: Array<(row: any) => boolean> = [];
  const read = () =>
    (table === "commerce_products"
      ? products
      : table === "profiles"
        ? [
            {
              id: creatorId,
              username: "creator",
              page_published: true,
              commerce_payment_provider: mocks.provider,
            },
          ]
        : []
    ).filter((row) => predicates.every((predicate) => predicate(row)));
  const q: any = {
    select: () => q,
    eq: (key: string, value: unknown) => {
      predicates.push((row) => row[key] === value);
      return q;
    },
    in: (key: string, values: unknown[]) => {
      predicates.push((row) => values.includes(row[key]));
      return q;
    },
    or: () => q,
    order: () => q,
    limit: () => q,
    single: async () => ({ data: read()[0] || null, error: null }),
    maybeSingle: async () => ({ data: read()[0] || null, error: null }),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: read(), error: null }).then(resolve),
  };
  return q;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider = "stripe";
  products = [
    {
      id: productId,
      creator_id: creatorId,
      kind: "bundle",
      status: "published",
      title: "Studio launch pack",
      description: "Two resources for launching your studio",
      slug: "studio-pack",
      public_slug: "studio-pack",
      pricing_type: "one_time",
      price_amount: 1900,
      currency: "usd",
      billing_interval: null,
      cta_label: "Buy bundle",
      settings: { bundledProductIds: childIds },
      inventory_limit: null,
      sales_count: 0,
    },
    ...childIds.map((id, index) => ({
      id,
      creator_id: creatorId,
      kind: index ? "course" : "digital_product",
      status: "published",
      title: `Resource ${index}`,
      settings: {},
      pricing_type: "one_time",
      price_amount: 500,
      currency: "usd",
    })),
  ];
  mocks.from.mockImplementation(query);
  mocks.adapter.mockResolvedValue({ url: "https://checkout.example.test", test: true });
});
const detail = () =>
  getPublicCommerceProduct({ data: { username: "creator", publicSlug: "studio-pack" } });
const quote = () => previewCommerceCheckout({ data: { productId } });
const checkout = () => createCommerceCheckout({ data: { productId, email: "buyer@example.com" } });
const publish = () => validateCommerceProductPublication(creatorId, products[0]);

describe("shared bundle boundaries use current actual child provider eligibility", () => {
  it.each(["stripe", "paypal", "razorpay", "polar", "dodo", "creem"])(
    "allows an eligible download/course bundle through %s publication, public detail, quote and checkout",
    async (provider) => {
      mocks.provider = provider;
      await expect(publish()).resolves.toBeUndefined();
      expect(await detail()).toMatchObject({ availabilityError: null });
      expect(await quote()).toMatchObject({ grossAmount: 1900 });
      await expect(checkout()).resolves.toMatchObject({ url: "https://checkout.example.test" });
      expect(mocks.adapter).toHaveBeenCalledExactlyOnceWith(
        provider,
        expect.objectContaining({ product: expect.objectContaining({ id: productId }) }),
      );
    },
  );
  it.each(["polar", "dodo", "creem"])(
    "rejects an included human-service custom offer for %s at every canonical paid boundary",
    async (provider) => {
      mocks.provider = provider;
      products[1].kind = "custom_product";
      await expect(publish()).rejects.toThrow(/included product is not eligible/);
      expect((await detail())?.availabilityError).toMatch(/included product is not eligible/);
      await expect(quote()).rejects.toThrow(/included product is not eligible/);
      await expect(checkout()).rejects.toThrow(/included product is not eligible/);
      expect(mocks.adapter).not.toHaveBeenCalled();
    },
  );
  it("does not let a nominally free human-service child bypass merchant-of-record eligibility", async () => {
    mocks.provider = "dodo";
    products[1].kind = "custom_product";
    products[1].pricing_type = "free";
    products[1].price_amount = 0;
    await expect(checkout()).rejects.toThrow(/included product is not eligible/);
    expect(mocks.adapter).not.toHaveBeenCalled();
  });
  it("loads children again on a later checkout after a valid published bundle's child changes", async () => {
    mocks.provider = "creem";
    await publish();
    await quote();
    products[1].kind = "custom_product";
    await expect(checkout()).rejects.toThrow(/included product is not eligible/);
    expect(mocks.adapter).not.toHaveBeenCalled();
  });
  it.each(["bundle", "newsletter"])(
    "rejects a nested or structurally ineligible %s child before provider dispatch",
    async (kind) => {
      products[1].kind = kind;
      await expect(publish()).rejects.toThrow(/Bundles can include/);
      await expect(quote()).rejects.toThrow(/Bundles can include/);
      await expect(checkout()).rejects.toThrow(/Bundles can include/);
      expect(mocks.adapter).not.toHaveBeenCalled();
    },
  );
});
