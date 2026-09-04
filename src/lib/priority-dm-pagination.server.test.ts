import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: database }));

import {
  loadPriorityDmConversationPage,
  loadPriorityDmInboxForCreator,
} from "./priority-dm.server";

const request = {
  id: "11111111-1111-4111-8111-111111111111",
  order_id: "22222222-2222-4222-8222-222222222222",
  product_id: "33333333-3333-4333-8333-333333333333",
  creator_id: "44444444-4444-4444-8444-444444444444",
  buyer_email: "buyer@example.com",
  buyer_name: "Buyer",
  status: "unread" as const,
  free_follow_up_limit: 2,
  follow_up_price_amount: 900,
  follow_up_currency: "usd",
  last_message_at: "2026-08-30T03:00:00.000Z",
  last_message_preview: "Newest message",
};

function resolvedQuery(data: unknown[]) {
  return {
    select: vi.fn().mockReturnValue({
      in: vi.fn().mockResolvedValue({ data, error: null }),
    }),
  };
}

function messageQuery(data: unknown[]) {
  const query: Record<string, ReturnType<typeof vi.fn>> & {
    then?: PromiseLike<{ data: unknown[]; error: null }>["then"];
  } = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    or: vi.fn(),
  };
  for (const method of ["select", "eq", "order", "limit", "or"] as const) {
    query[method].mockReturnValue(query);
  }
  query.then = (onFulfilled, onRejected) =>
    Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
  return query;
}

describe("Priority DM inbox pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds inbox summaries from request activity without loading messages", async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ ...request, product: { title: "Launch review" } }],
        error: null,
      }),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    const summaries = await loadPriorityDmInboxForCreator(client, request.creator_id);

    expect(client.from).toHaveBeenCalledOnce();
    expect(client.from).toHaveBeenCalledWith("commerce_priority_dm_requests");
    expect(query.select.mock.calls[0][0]).not.toContain("messages");
    expect(query.limit).toHaveBeenCalledWith(500);
    expect(summaries).toEqual([
      expect.objectContaining({
        id: request.id,
        productTitle: "Launch review",
        lastMessagePreview: "Newest message",
      }),
    ]);
    expect(summaries[0]).not.toHaveProperty("messages");
  });

  it("keeps the newest 100 selected-thread messages and returns an older-page cursor", async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      request_id: request.id,
      sender: index % 2 ? "creator" : "buyer",
      body: `Message ${index}`,
      order_id: null,
      created_at: new Date(Date.UTC(2026, 7, 30, 3, 0, 100 - index)).toISOString(),
    }));
    const messagesQuery = messageQuery(messages);
    database.from.mockImplementation((table: string) => {
      if (table === "commerce_priority_dm_messages") return messagesQuery;
      if (table === "commerce_products")
        return resolvedQuery([{ id: request.product_id, title: "Launch review" }]);
      if (table === "profiles")
        return resolvedQuery([
          { id: request.creator_id, username: "creator", display_name: "Creator" },
        ]);
      if (table === "commerce_orders")
        return resolvedQuery([{ id: request.order_id, status: "paid" }]);
      throw new Error(`Unexpected table ${table}`);
    });

    const page = await loadPriorityDmConversationPage(request, true);

    expect(
      database.from.mock.calls.filter(([table]) => table === "commerce_priority_dm_messages"),
    ).toHaveLength(1);
    expect(messagesQuery.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
    expect(messagesQuery.order).toHaveBeenNthCalledWith(2, "id", { ascending: false });
    expect(messagesQuery.limit).toHaveBeenCalledWith(101);
    expect(page.conversation.messages).toHaveLength(100);
    expect(page.conversation.messages.at(-1)?.body).toBe("Message 0");
    expect(page.nextCursor).toEqual({
      createdAt: messages[99].created_at,
      id: messages[99].id,
    });
  });

  it("uses both timestamp and message id when loading an earlier page", async () => {
    const messagesQuery = messageQuery([]);
    database.from.mockImplementation((table: string) => {
      if (table === "commerce_priority_dm_messages") return messagesQuery;
      if (table === "commerce_products")
        return resolvedQuery([{ id: request.product_id, title: "Launch review" }]);
      if (table === "profiles")
        return resolvedQuery([
          { id: request.creator_id, username: "creator", display_name: "Creator" },
        ]);
      if (table === "commerce_orders")
        return resolvedQuery([{ id: request.order_id, status: "paid" }]);
      throw new Error(`Unexpected table ${table}`);
    });
    const before = {
      createdAt: "2026-08-30T02:00:00.000Z",
      id: "55555555-5555-4555-8555-555555555555",
    };

    await loadPriorityDmConversationPage(request, true, before);

    expect(messagesQuery.or).toHaveBeenCalledWith(
      `created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`,
    );
  });
});
