// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendCreatorPriorityDmMessage,
  setPriorityDmConversationClosed,
} from "./priority-dm.functions";
import { createPriorityDmWebMcpTools } from "./priority-dm-webmcp";

vi.mock("./priority-dm.functions", () => ({
  sendCreatorPriorityDmMessage: vi.fn(),
  setPriorityDmConversationClosed: vi.fn(),
}));

const requestId = "33333333-3333-4333-8333-333333333333";
const signal = new AbortController().signal;
const conversation = {
  id: requestId,
  productId: "11111111-1111-4111-8111-111111111111",
  productTitle: "Launch review",
  buyerName: "Buyer",
  buyerEmail: "buyer@example.com",
  creatorName: "Creator",
  creatorUsername: "creator",
  status: "unread" as const,
  freeFollowUpLimit: 2,
  freeFollowUpsUsed: 1,
  freeFollowUpsRemaining: 1,
  followUpPriceAmount: 900,
  currency: "usd",
  lastMessageAt: "2026-08-30T03:00:00.000Z",
  lastMessagePreview: "Can you review this private order?",
  canReply: true,
  readOnlyReason: null,
  orderId: "private-order",
  accessUrl: "https://secret.example/link",
  messages: Array.from({ length: 110 }, (_, index) => ({
    id: `message-${index}`,
    sender: index % 2 ? ("creator" as const) : ("buyer" as const),
    body: `Message ${index}`,
    createdAt: `2026-08-30T03:${String(index % 60).padStart(2, "0")}:00.000Z`,
  })),
};

function tools(refresh = vi.fn(), conversations = [conversation]) {
  return createPriorityDmWebMcpTools({ conversations, refresh });
}

function tool(name: string, refresh = vi.fn()) {
  return tools(refresh).find((item) => item.name === name)!;
}

describe("Priority DM WebMCP tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns bounded inbox summaries without buyer email, messages, or order/link data", async () => {
    const result = await tool("bento_get_priority_dm_conversations").execute({}, { signal });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      structuredContent: {
        conversations: [{ id: requestId, buyerName: "Buyer", productTitle: "Launch review" }],
      },
    });
    expect(
      (result as { structuredContent: { conversations: Array<Record<string, unknown>> } })
        .structuredContent.conversations[0],
    ).not.toHaveProperty("messages");
    expect(serialized).not.toMatch(
      /buyer@example|private-order|secret\.example|buyerEmail|orderId/i,
    );
  });

  it("caps a 101-conversation result at the requested maximum", async () => {
    const conversations = Array.from({ length: 101 }, (_, index) => ({
      ...conversation,
      id: `conversation-${index}`,
    }));
    const result = await tools(vi.fn(), conversations)
      .find((item) => item.name === "bento_get_priority_dm_conversations")!
      .execute({ limit: 100 }, { signal });
    const content = (
      result as {
        structuredContent: { conversations: unknown[]; loadedCount: number };
      }
    ).structuredContent;

    expect(content.loadedCount).toBe(101);
    expect(content.conversations).toHaveLength(100);
  });

  it("requires browser confirmation before sending or closing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);

    await expect(
      tool("bento_send_priority_dm_message").execute({ requestId, body: "Reply" }, { signal }),
    ).rejects.toThrow("did not approve");
    await expect(
      tool("bento_set_priority_dm_closed").execute({ requestId, closed: true }, { signal }),
    ).rejects.toThrow("did not approve");
    expect(sendCreatorPriorityDmMessage).not.toHaveBeenCalled();
    expect(setPriorityDmConversationClosed).not.toHaveBeenCalled();
  });

  it("uses owned append and close functions after approval and refreshes once", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(sendCreatorPriorityDmMessage).mockResolvedValue({ id: "message-1" });
    vi.mocked(setPriorityDmConversationClosed).mockResolvedValue({ ok: true });

    const sent = await tool("bento_send_priority_dm_message", refresh).execute(
      { requestId, body: "  Reply  " },
      { signal },
    );
    await tool("bento_set_priority_dm_closed", refresh).execute(
      { requestId, closed: true },
      { signal },
    );

    expect(sendCreatorPriorityDmMessage).toHaveBeenCalledWith({
      data: { requestId, body: "Reply" },
    });
    expect(sent).toMatchObject({
      structuredContent: { requestId, messageId: "message-1" },
    });
    expect(setPriorityDmConversationClosed).toHaveBeenCalledWith({
      data: { requestId, closed: true },
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
