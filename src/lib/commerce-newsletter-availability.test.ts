/* eslint-disable @typescript-eslint/no-explicit-any -- Provider and database boundaries use scoped in-memory rows. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  adapter: vi.fn(),
  rpc: vi.fn(),
  canvas: null as any,
  plan: "creator",
  provider: "stripe",
  grant: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (value: any) => value;
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
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./plan.server", () => ({
  getPlan: async () => mocks.plan,
  requirePlanEntitlement: vi.fn(),
}));
vi.mock("./profile.functions", () => ({ loadPublicCreatorPage: async () => mocks.canvas }));
vi.mock("./public-creator-chrome.server", () => ({
  loadPublicCreatorChrome: async () => ({ creator: { username: "creator" }, pages: [] }),
}));
vi.mock("./username-alias.server", () => ({
  resolvePublicUsername: async () => ({ userId: "33333333-3333-4333-8333-333333333333" }),
}));
vi.mock("./payment-connection-policy.server", () => ({
  creatorStorePaymentSetup: vi.fn(),
  requireCreatorStorePaymentSetup: vi.fn(),
  requireReadyCreatorPaymentProvider: vi.fn(),
}));
vi.mock("./commerce-access.server", () => ({ resolveCommerceGrantByToken: mocks.grant }));
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
  getPublicCommerceStore,
  getCommerceAccess,
} from "./commerce.functions";

const creatorId = "33333333-3333-4333-8333-333333333333";
const productId = "55555555-5555-4555-8555-555555555555";
const publicationId = "11111111-1111-4111-8111-111111111111";
let products: any[];
let publications: any[];
function query(table: string) {
  const predicates: Array<(row: any) => boolean> = [];
  let limit = Infinity;
  const read = () => {
    const rows =
      table === "commerce_products"
        ? products
        : table === "newsletter_publications"
          ? publications
          : table === "profiles"
            ? [
                {
                  id: creatorId,
                  username: "creator",
                  display_name: "Creator",
                  page_published: true,
                  store_page_enabled: true,
                  onboarded: true,
                  commerce_payment_provider: mocks.provider,
                },
              ]
            : [];
    return rows.filter((row) => predicates.every((predicate) => predicate(row))).slice(0, limit);
  };
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
    order: () => q,
    limit: (max: number) => {
      limit = max;
      return q;
    },
    update: () => q,
    maybeSingle: async () => ({ data: read()[0] || null, error: null }),
    single: async () => ({ data: read()[0] || null, error: null }),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: read(), error: null }).then(resolve),
  };
  return q;
}
const checkoutInput = { productId, email: "buyer@example.com" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.plan = "creator";
  mocks.provider = "stripe";
  mocks.canvas = null;
  products = [
    {
      id: productId,
      creator_id: creatorId,
      kind: "newsletter",
      status: "published",
      title: "Studio notes",
      description: "The monthly studio publication",
      slug: "studio-notes",
      public_slug: "studio-notes",
      pricing_type: "subscription",
      price_amount: 900,
      currency: "usd",
      billing_interval: "month",
      cta_label: "Subscribe",
      settings: { newsletterPublicationId: publicationId },
      inventory_limit: null,
      sales_count: 0,
    },
  ];
  publications = [
    { id: publicationId, creator_id: creatorId, status: "published", paid_product_id: productId },
  ];
  mocks.from.mockImplementation(query);
  mocks.adapter.mockResolvedValue({ url: "https://checkout.example.test", test: true });
});

describe("new paid newsletter purchases require their current canonical publication", () => {
  it.each(["stripe", "paypal", "razorpay", "polar", "dodo", "creem"])(
    "rejects a buyer who cannot be enrolled before %s creates a payment resource",
    async (provider) => {
      mocks.provider = provider;
      mocks.rpc.mockResolvedValue({ data: false, error: null });
      await expect(createCommerceCheckout({ data: checkoutInput })).rejects.toThrow(
        "This newsletter cannot accept a new email subscription right now.",
      );
      expect(mocks.rpc).toHaveBeenCalledWith("can_accept_paid_newsletter_checkout", {
        p_product_id: productId,
        p_email: checkoutInput.email,
      });
      expect(mocks.adapter).not.toHaveBeenCalled();
    },
  );

  it("fails closed before provider checkout when newsletter enrollment capacity cannot be verified", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "Capacity unavailable" } });
    await expect(createCommerceCheckout({ data: checkoutInput })).rejects.toThrow(
      "Newsletter enrollment could not be verified. Please try again.",
    );
    expect(mocks.adapter).not.toHaveBeenCalled();
  });
  it.each(["stripe", "paypal", "razorpay", "polar", "dodo", "creem"])(
    "allows a correctly bound published publication through %s",
    async (provider) => {
      mocks.provider = provider;
      expect(await previewCommerceCheckout({ data: { productId } })).toMatchObject({
        grossAmount: 900,
      });
      await expect(createCommerceCheckout({ data: checkoutInput })).resolves.toMatchObject({
        url: "https://checkout.example.test",
      });
      expect(mocks.adapter).toHaveBeenCalledExactlyOnceWith(
        provider,
        expect.objectContaining({ product: expect.objectContaining({ id: productId }) }),
      );
    },
  );
  it.each([
    ["archived publication", { status: "archived" }],
    ["draft publication", { status: "draft" }],
    ["another creator's publication", { creator_id: "22222222-2222-4222-8222-222222222222" }],
    [
      "a publication bound to another paid product",
      { paid_product_id: "66666666-6666-4666-8666-666666666666" },
    ],
    ["an unlinked publication", { paid_product_id: null }],
  ])(
    "blocks direct details, quote and checkout for %s while the stale offer remains published",
    async (_label, changes) => {
      Object.assign(publications[0], changes);
      await expect(
        getPublicCommerceProduct({ data: { username: "creator", publicSlug: "studio-notes" } }),
      ).resolves.toBeNull();
      await expect(previewCommerceCheckout({ data: { productId } })).rejects.toThrow(
        /newsletter.*(available|published)|publication/i,
      );
      await expect(createCommerceCheckout({ data: checkoutInput })).rejects.toThrow(
        /newsletter.*(available|published)|publication/i,
      );
      expect(mocks.adapter).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects a missing publication and a forged non-UUID binding before adapter or free-claim writes", async () => {
    publications = [];
    await expect(createCommerceCheckout({ data: checkoutInput })).rejects.toThrow(
      /newsletter|publication/i,
    );
    products[0].settings.newsletterPublicationId = "forged";
    await expect(getPublicCommerceProduct({ data: { slug: "studio-notes" } })).resolves.toBeNull();
    await expect(previewCommerceCheckout({ data: { productId } })).rejects.toThrow(
      /newsletter|publication/i,
    );
    expect(mocks.adapter).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects quote and checkout after downgrade removes Newsletter entitlement while leaving checkout entitlement", async () => {
    mocks.plan = "store";
    await expect(previewCommerceCheckout({ data: { productId } })).rejects.toThrow(
      /newsletter|publication|not available/i,
    );
    await expect(createCommerceCheckout({ data: checkoutInput })).rejects.toThrow(
      /newsletter|publication|not available/i,
    );
    expect(mocks.adapter).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("removes unavailable paid newsletters from the standalone public Store", async () => {
    publications[0].status = "archived";
    const result = await getPublicCommerceStore({ data: { username: "creator" } });
    expect(result?.products).toEqual([]);
  });
  it("revalidates sanitized canvas products against trusted rows and removes unavailable items from every public Store projection", async () => {
    publications[0].status = "archived";
    const sanitized = { ...products[0], settings: {} };
    delete sanitized.creator_id;
    mocks.canvas = {
      notFound: false,
      page: { id: "store-page" },
      systemItems: [{ id: "stale-card", kind: "product", data: sanitized }],
    };
    const result = await getPublicCommerceStore({ data: { username: "creator" } });
    expect(result).toMatchObject({ products: [], domainData: { products: [] }, systemItems: [] });
  });
  it("keeps valid published newsletter details and sanitized Store cards visible", async () => {
    expect(
      await getPublicCommerceProduct({ data: { username: "creator", publicSlug: "studio-notes" } }),
    ).toMatchObject({ product: { id: productId }, availabilityError: null });
    expect(await getPublicCommerceStore({ data: { username: "creator" } })).toMatchObject({
      products: [{ id: productId }],
    });
    const sanitized = { ...products[0], settings: {} };
    delete sanitized.creator_id;
    mocks.canvas = {
      notFound: false,
      page: { id: "store-page" },
      systemItems: [{ id: "live-card", kind: "product", data: sanitized }],
    };
    expect(await getPublicCommerceStore({ data: { username: "creator" } })).toMatchObject({
      products: [{ id: productId }],
      systemItems: [{ id: "live-card" }],
    });
  });
  it("preserves unrelated published products when a stale newsletter is removed from the Store", async () => {
    publications[0].status = "archived";
    products.push({
      ...products[0],
      id: "77777777-7777-4777-8777-777777777777",
      kind: "digital_product",
      pricing_type: "one_time",
      settings: {},
    });
    const result = await getPublicCommerceStore({ data: { username: "creator" } });
    expect(result?.products).toEqual([
      expect.objectContaining({ id: products[1].id, kind: "digital_product" }),
    ]);
  });
  it("does not revoke a preexisting paid access grant when new purchases are disabled", async () => {
    publications[0].status = "archived";
    mocks.grant.mockResolvedValue({
      id: "grant",
      product_id: productId,
      creator_id: creatorId,
      status: "active",
      order_id: null,
    });
    const result = await getCommerceAccess({ data: { token: "x".repeat(43) } });
    expect(result).toMatchObject({ grant: { status: "active" }, product: { id: productId } });
  });
});
