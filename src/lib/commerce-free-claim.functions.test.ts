/* eslint-disable @typescript-eslint/no-explicit-any -- Server and database boundaries are exercised with deterministic free-claim fixtures. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  productId: "11111111-1111-4111-8111-111111111111",
  creatorId: "22222222-2222-4222-8222-222222222222",
  originalOrder: "33333333-3333-4333-8333-333333333333",
  inventoryLimit: null as number | null,
  confirmationProvider: null as string | null,
  decrypt: vi.fn(),
  rpc: vi.fn(),
  email: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: any) => fn,
  createServerFn: () => {
    let validate = (data: any) => data;
    const builder: any = {
      middleware: () => builder,
      validator: (fn: any) => {
        validate = fn;
        return builder;
      },
      handler: (fn: any) => (input: any) => fn({ data: validate(input.data) }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("./plan.server", () => ({ getPlan: async () => "store", requirePlanEntitlement: vi.fn() }));
vi.mock("./email.server", () => ({ enqueueCommerceOrderEmails: fixtures.email }));
vi.mock("./secret-crypto.server", () => ({
  encryptServerSecret: async (token: string) => `encrypted:${token}`,
  decryptServerSecret: fixtures.decrypt,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: fixtures.rpc,
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const originalOrder: Record<string, unknown> = {
        id: fixtures.originalOrder,
        product_id: fixtures.productId,
        provider: fixtures.confirmationProvider,
        status: "paid",
        provider_checkout_id: "free_" + "f".repeat(64),
        metadata: { access_token_ciphertext: "encrypted-victim-capability" },
      };
      const query: any = {
        order: () => query,
        limit: () => query,
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return query;
        },
        maybeSingle: async () => ({
          data:
            table === "commerce_products"
              ? {
                  id: fixtures.productId,
                  creator_id: fixtures.creatorId,
                  kind: "paid_community",
                  title: "Free community",
                  description: "Community description",
                  pricing_type: "free",
                  price_amount: 0,
                  billing_interval: null,
                  currency: "usd",
                  public_slug: "free-community",
                  settings: { welcomeMessage: "Welcome" },
                  status: "published",
                  inventory_limit: fixtures.inventoryLimit,
                  sales_count: 1,
                }
              : table === "commerce_orders" &&
                  fixtures.confirmationProvider &&
                  filters.every(([key, value]) => originalOrder[key] === value)
                ? originalOrder
                : null,
          error: null,
        }),
        single: async () => ({
          data: { username: "creator", commerce_payment_provider: "disabled" },
          error: null,
        }),
      };
      return query;
    },
  },
}));

import { createCommerceCheckout, getCommerceOrderConfirmation } from "./commerce.functions";

const checkout = () =>
  createCommerceCheckout({ data: { productId: fixtures.productId, email: "victim@example.com" } });

describe("anonymous repeat free claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.inventoryLimit = null;
    fixtures.confirmationProvider = null;
    fixtures.decrypt.mockResolvedValue("v".repeat(43));
    vi.stubEnv("VITE_PUBLIC_URL", "https://public.bento.surf");
  });

  it("requires library sign-in instead of exposing an existing order or access capability", async () => {
    fixtures.rpc.mockResolvedValue({
      data: { created_new_order: false, order_id: fixtures.originalOrder },
      error: null,
    });
    const result = await checkout();
    const url = new URL(result.url);
    expect(url.pathname).toBe("/library/");
    expect(url.search).toBe("");
    expect(result.url).not.toContain(fixtures.originalOrder);
    expect(result).not.toHaveProperty("accessToken");
    expect(fixtures.email).not.toHaveBeenCalled();
  });

  it("accepts a private repeated-claim result without any original order identifier", async () => {
    fixtures.rpc.mockResolvedValue({ data: { created_new_order: false }, error: null });
    await expect(checkout()).resolves.toMatchObject({
      url: "https://public.bento.surf/library/",
      test: false,
    });
    expect(fixtures.email).not.toHaveBeenCalled();
  });

  it("routes an existing free buyer to verified library recovery even when inventory is full", async () => {
    fixtures.inventoryLimit = 1;
    fixtures.rpc.mockResolvedValue({ data: { created_new_order: false }, error: null });
    await expect(checkout()).resolves.toMatchObject({
      url: "https://public.bento.surf/library/",
      test: false,
    });
  });

  it("keeps a first anonymous claim usable with its new order and matching new grant", async () => {
    fixtures.rpc.mockResolvedValue({
      data: { created_new_order: true, order_id: fixtures.originalOrder },
      error: null,
    });
    const result = await checkout();
    const url = new URL(result.url);
    expect(url.pathname).toBe("/@creator/products/free-community/success");
    expect(url.searchParams.get("order")).toBe(fixtures.originalOrder);
    expect(url.searchParams.get("access")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fixtures.email).toHaveBeenCalledOnce();
  });
});

describe("free purchase confirmation privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.confirmationProvider = "free";
    fixtures.decrypt.mockResolvedValue("v".repeat(43));
  });

  it("rejects publicly computable free checkout references without disclosing the original order", async () => {
    await expect(
      getCommerceOrderConfirmation({
        data: { productId: fixtures.productId, reference: "free_" + "f".repeat(64) },
      }),
    ).resolves.toEqual({
      state: "not_found",
      orderId: null,
      priorityDmRequestId: null,
      accessToken: null,
    });
    expect(fixtures.decrypt).not.toHaveBeenCalled();
  });

  it("does not recover free access even from an existing order UUID", async () => {
    await expect(
      getCommerceOrderConfirmation({
        data: { productId: fixtures.productId, reference: fixtures.originalOrder },
      }),
    ).resolves.toEqual({
      state: "confirmed",
      orderId: fixtures.originalOrder,
      priorityDmRequestId: null,
      accessToken: null,
    });
    expect(fixtures.decrypt).not.toHaveBeenCalled();
  });

  it("retains encrypted access recovery for a paid provider's unguessable order reference", async () => {
    fixtures.confirmationProvider = "stripe";
    await expect(
      getCommerceOrderConfirmation({
        data: { productId: fixtures.productId, reference: fixtures.originalOrder },
      }),
    ).resolves.toMatchObject({ state: "confirmed", accessToken: "v".repeat(43) });
    expect(fixtures.decrypt).toHaveBeenCalledWith("encrypted-victim-capability");
  });
});
