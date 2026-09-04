import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  request: null as Record<string, unknown> | null,
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: database }));

import { recordPriorityDmOrder } from "./priority-dm.server";

describe("recordPriorityDmOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.request = null;
    database.from.mockImplementation((table: string) => {
      if (table !== "commerce_priority_dm_requests") throw new Error(`Unexpected table ${table}`);
      return {
        upsert: vi.fn(
          (values: Record<string, unknown>, options?: { ignoreDuplicates?: boolean }) => {
            const duplicate = Boolean(database.request);
            if (!database.request || !options?.ignoreDuplicates) {
              database.request = { id: "request-1", ...values };
            }
            return {
              error: null,
              select: () => ({
                single: async () => ({
                  data:
                    duplicate && options?.ignoreDuplicates ? null : { id: database.request?.id },
                  error: null,
                }),
              }),
            };
          },
        ),
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { id: database.request?.id }, error: null }),
          }),
        }),
      };
    });
    database.rpc.mockResolvedValue({ data: { id: "message-1" }, error: null });
  });

  it("keeps the first purchased snapshot when initial fulfillment is replayed", async () => {
    const base = {
      order: {
        id: "order-1",
        product_id: "product-1",
        creator_id: "creator-1",
        buyer_email: "first@example.com",
        buyer_name: "First buyer",
      },
      product: {
        id: "product-1",
        kind: "priority_dm",
        price_amount: 2500,
        currency: "usd",
        settings: { freeFollowUpLimit: 2, followUpPriceAmount: 900 },
      },
      buyerAnswers: [{ question: "Priority message", answer: "Original question" }],
    };

    await recordPriorityDmOrder(base);
    await recordPriorityDmOrder({
      ...base,
      order: {
        ...base.order,
        buyer_email: "changed@example.com",
        buyer_name: "Changed buyer",
      },
      product: {
        ...base.product,
        currency: "eur",
        settings: { freeFollowUpLimit: 9, followUpPriceAmount: 1900 },
      },
      buyerAnswers: [{ question: "Priority message", answer: "Changed question" }],
    });

    expect(database.request).toMatchObject({
      buyer_email: "first@example.com",
      buyer_name: "First buyer",
      message: "Original question",
      free_follow_up_limit: 2,
      follow_up_price_amount: 900,
      follow_up_currency: "usd",
    });
  });
});
