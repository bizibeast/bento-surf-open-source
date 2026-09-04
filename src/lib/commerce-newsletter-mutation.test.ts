import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(() => {
    const product = {
      id: "55555555-5555-4555-8555-555555555555",
      creator_id: "33333333-3333-4333-8333-333333333333",
      kind: "newsletter",
      status: "published",
      settings: {},
    };
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({ data: product, error: null }),
      single: vi.fn().mockResolvedValue({ data: product, error: null }),
      update: vi.fn((value: unknown) => {
        mocks.update(value);
        return query;
      }),
    };
    return query;
  }),
}));

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
        (
          handler: (input: {
            data: never;
            context: { userId: string; supabase: unknown };
          }) => unknown,
        ) =>
        (input?: { data?: unknown }) =>
          handler({
            data: validate(input?.data) as never,
            context: {
              userId: "33333333-3333-4333-8333-333333333333",
              supabase: { from: mocks.from, rpc: mocks.rpc },
            },
          }),
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
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

import { createCommerceProduct, updateCommerceProduct } from "./commerce.functions";
import { addCommerceProductBlock, setCommerceProductStatus } from "./commerce.functions";
import { deleteCommerceProduct } from "./commerce-delete.functions";

const product = {
  kind: "newsletter" as const,
  title: "Studio Notes paid newsletter",
  subtitle: "Paid newsletter",
  description: "Paid Studio Notes.",
  cover_url: null,
  pricing_type: "subscription" as const,
  price_amount: 900,
  currency: "usd",
  billing_interval: "month" as const,
  cta_label: "Subscribe",
  settings: { newsletterPublicationId: "11111111-1111-4111-8111-111111111111" },
  inventory_limit: null,
  noindex: false,
};

describe("newsletter commerce mutation boundary", () => {
  it("rejects generic Store creation before touching commerce storage", async () => {
    await expect(
      createCommerceProduct({ data: { product, addToBento: false, pageId: null } }),
    ).rejects.toThrow("Manage paid newsletters in Email Marketing.");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects generic Store updates before touching commerce storage", async () => {
    await expect(
      updateCommerceProduct({
        data: { id: "55555555-5555-4555-8555-555555555555", product },
      }),
    ).rejects.toThrow("Manage paid newsletters in Email Marketing.");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects an owned newsletter even when a generic update disguises the requested kind", async () => {
    await expect(
      updateCommerceProduct({
        data: {
          id: "55555555-5555-4555-8555-555555555555",
          product: {
            ...product,
            kind: "digital_product",
            pricing_type: "one_time",
            billing_interval: null,
            settings: { files: [] },
          },
        },
      }),
    ).rejects.toThrow("Manage paid newsletters in Email Marketing.");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    () =>
      setCommerceProductStatus({
        data: { id: "55555555-5555-4555-8555-555555555555", status: "archived" },
      }),
    () =>
      addCommerceProductBlock({
        data: { productId: "55555555-5555-4555-8555-555555555555", pageId: null },
      }),
    () =>
      deleteCommerceProduct({
        data: { productId: "55555555-5555-4555-8555-555555555555" },
      }),
  ])(
    "rejects a generic newsletter mutation after the ownership read and before a write",
    async (run) => {
      await expect(run()).rejects.toThrow("Manage paid newsletters in Email Marketing.");
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
});
