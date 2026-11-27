import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessionId: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  orderId: "33333333-3333-4333-8333-333333333333",
  sessionStatus: "paid",
  orderStatus: "paid",
  followUpId: null as string | null,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      middleware: () => builder,
      validator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) =>
        fn({ data: validate(input.data) }),
    };
    return builder;
  },
}));
vi.mock("./request-security.server", () => ({ enforceRequestRateLimit: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const rows: Record<string, unknown>[] =
        table === "commerce_orders"
          ? [
              {
                id: state.orderId,
                product_id: state.productId,
                status: state.orderStatus,
                provider_checkout_id: "subscription-payment-sale123",
                "metadata->>bento_session_id": state.sessionId,
                metadata: {
                  bento_session_id: state.sessionId,
                  commerce_intent: "priority_dm_followup",
                  priority_dm_request_id: state.followUpId,
                },
              },
            ]
          : [
              {
                id: state.sessionId,
                product_id: state.productId,
                status: state.sessionStatus,
                provider_checkout_id: "subscription123",
                metadata: {},
              },
            ];
      const filters: Array<[string, unknown]> = [];
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]);
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({
          data: rows.find((row) => filters.every(([key, value]) => row[key] === value)) ?? null,
          error: null,
        }),
      };
      return query;
    },
  },
}));

import { getCommerceOrderConfirmation } from "./commerce.functions";

describe("subscription order confirmation", () => {
  beforeEach(() => {
    state.sessionStatus = "paid";
    state.orderStatus = "paid";
    state.followUpId = null;
  });

  it("resolves a session reference to the paid order when each recurring sale has its own checkout ID", async () => {
    await expect(
      getCommerceOrderConfirmation({
        data: { productId: state.productId, reference: state.sessionId },
      }),
    ).resolves.toMatchObject({ state: "confirmed", orderId: state.orderId });
  });

  it("honors refunded orders even when the original checkout session is paid", async () => {
    state.orderStatus = "refunded";
    await expect(
      getCommerceOrderConfirmation({
        data: { productId: state.productId, reference: state.sessionId },
      }),
    ).resolves.toMatchObject({ state: "unavailable", orderId: state.orderId, accessToken: null });
  });

  it("does not resolve a session for a different product", async () => {
    await expect(
      getCommerceOrderConfirmation({
        data: { productId: "44444444-4444-4444-8444-444444444444", reference: state.sessionId },
      }),
    ).resolves.toMatchObject({ state: "not_found", orderId: null, accessToken: null });
  });

  it("returns a paid follow-up conversation only for confirmed valid metadata", async () => {
    state.followUpId = "55555555-5555-4555-8555-555555555555";
    const data = { productId: state.productId, reference: state.sessionId };
    await expect(getCommerceOrderConfirmation({ data })).resolves.toMatchObject({
      state: "confirmed",
      priorityDmRequestId: state.followUpId,
    });
    state.orderStatus = "refunded";
    await expect(getCommerceOrderConfirmation({ data })).resolves.toMatchObject({
      state: "unavailable",
      priorityDmRequestId: null,
    });
    state.orderStatus = "paid";
    state.followUpId = "not-a-conversation-id";
    await expect(getCommerceOrderConfirmation({ data })).resolves.toMatchObject({
      state: "confirmed",
      priorityDmRequestId: null,
    });
  });
});
