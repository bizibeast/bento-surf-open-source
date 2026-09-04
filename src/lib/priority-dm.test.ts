import { describe, expect, it } from "vitest";
import {
  priorityDmFollowUpAnswer,
  priorityDmFollowUpContext,
  priorityDmPolicy,
} from "./priority-dm";
import { mapPriorityDmConversationView } from "./priority-dm.server";

const requestId = "11111111-1111-4111-8111-111111111111";

describe("Priority DM policy", () => {
  it("normalizes explicit and legacy follow-up rules", () => {
    expect(priorityDmPolicy({ freeFollowUpLimit: 2, followUpPriceAmount: 900 }, 1900)).toEqual({
      freeFollowUpLimit: 2,
      followUpPriceAmount: 900,
    });
    expect(priorityDmPolicy({}, 1900)).toEqual({
      freeFollowUpLimit: 0,
      followUpPriceAmount: 1900,
    });
  });

  it("round-trips only a valid server-created paid follow-up context", () => {
    const answer = priorityDmFollowUpAnswer(requestId, "One more question");
    expect(priorityDmFollowUpContext([answer])).toEqual({
      requestId,
      body: "One more question",
    });
    expect(priorityDmFollowUpContext([{ question: "Priority follow-up", answer: "x" }])).toBeNull();
  });
});

describe("Priority DM conversation view", () => {
  const input = {
    request: {
      id: "11111111-1111-4111-8111-111111111111",
      product_id: "22222222-2222-4222-8222-222222222222",
      buyer_name: "Maya",
      buyer_email: "maya@example.com",
      status: "unread",
      free_follow_up_limit: 2,
      follow_up_price_amount: 900,
      follow_up_currency: "usd",
      last_message_at: "2026-08-30T10:00:00.000Z",
      last_message_preview: "Second question",
    },
    product: { title: "Launch review" },
    creator: { display_name: "Ari", username: "ari" },
    order: { status: "paid" },
    messages: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        sender: "buyer",
        body: "Initial question",
        order_id: "44444444-4444-4444-8444-444444444444",
        created_at: "2026-08-30T09:00:00.000Z",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        sender: "buyer",
        body: "Second question",
        order_id: null,
        created_at: "2026-08-30T10:00:00.000Z",
      },
    ],
  } as const;

  it("returns follow-up counts and omits buyer email from the buyer projection", () => {
    expect(mapPriorityDmConversationView(input, false)).toMatchObject({
      buyerName: "Maya",
      creatorName: "Ari",
      freeFollowUpsUsed: 1,
      freeFollowUpsRemaining: 1,
      canReply: true,
      readOnlyReason: null,
    });
    expect(mapPriorityDmConversationView(input, false).messages[0]).toMatchObject({
      sender: "buyer",
      body: "Initial question",
    });
    expect(mapPriorityDmConversationView(input, false)).not.toHaveProperty("buyerEmail");
  });

  it("keeps refunded history visible but marks it read-only", () => {
    expect(
      mapPriorityDmConversationView({ ...input, order: { status: "refunded" as const } }, true),
    ).toMatchObject({
      buyerEmail: "maya@example.com",
      canReply: false,
      readOnlyReason: "This purchase is no longer eligible for replies.",
    });
  });
});
