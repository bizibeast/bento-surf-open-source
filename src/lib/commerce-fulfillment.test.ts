import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  enqueueCommerceOrderEmails: vi.fn(),
  decryptServerSecret: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({ maybeSingle: mocks.maybeSingle })),
        })),
      })),
    })),
  },
}));
vi.mock("./email.server", () => ({
  enqueueCommerceOrderEmails: mocks.enqueueCommerceOrderEmails,
}));
vi.mock("./secret-crypto.server", () => ({
  decryptServerSecret: mocks.decryptServerSecret,
}));

import {
  commerceBuyerAnswersFromSession,
  commerceFulfillmentMatchKey,
  commerceOrderMetadata,
  commerceOrderEmailKeys,
  finalizeCommerceFulfillment,
} from "./commerce-fulfillment.server";
import { priorityDmFollowUpAnswer } from "./priority-dm";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

describe("commerce fulfillment helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeSingle.mockResolvedValue({ data: { id: "session-1" }, error: null });
    mocks.decryptServerSecret.mockResolvedValue("private-token");
    mocks.enqueueCommerceOrderEmails.mockResolvedValue("outbox-1");
  });

  it("names provider checkout matches without cross-provider collisions", () => {
    expect(commerceFulfillmentMatchKey("Stripe", "cs_123")).toBe("stripe:cs_123");
    expect(commerceFulfillmentMatchKey("paypal", "cs_123")).not.toBe(
      commerceFulfillmentMatchKey("stripe", "cs_123"),
    );
  });

  it("uses stable idempotency keys for both order notifications", () => {
    expect(commerceOrderEmailKeys("order-1")).toEqual([
      "buyer-receipt:order-1",
      "creator-sale:order-1",
    ]);
    expect(commerceOrderEmailKeys("order-1", { priorityDmMessageId: "message-1" })).toEqual([
      "buyer-receipt:order-1",
      "priority-dm-message:message-1:creator",
    ]);
    expect(commerceOrderEmailKeys("order-1", { priorityDmMessageId: null })).toEqual([
      "buyer-receipt:order-1",
    ]);
    expect(
      commerceOrderEmailKeys("legacy-order", {
        priorityDmMessageId: "legacy-message",
        notificationEligible: false,
      }),
    ).toEqual(["buyer-receipt:legacy-order"]);
  });

  it("copies only bounded, valid buyer answers into order metadata", () => {
    expect(
      commerceOrderMetadata(
        {
          id: "session-1",
          provider: "stripe",
          metadata: {
            buyer_answers: [
              { question: "  Company  ", answer: "  Bento  " },
              null,
              { question: "", answer: "ignored" },
            ],
          },
        },
        { stripe_checkout_session_id: "cs_123" },
      ),
    ).toEqual({
      stripe_checkout_session_id: "cs_123",
      buyer_answers: [{ question: "Company", answer: "Bento" }],
    });
  });

  it("promotes only a validated server-created Priority DM follow-up", () => {
    expect(
      commerceOrderMetadata({
        id: "session-1",
        provider: "stripe",
        metadata: {
          buyer_answers: [priorityDmFollowUpAnswer(requestId, "Paid question")],
        },
      }),
    ).toMatchObject({
      buyer_answers: [
        {
          question: "Priority follow-up",
          answer: "Paid question",
          priorityDmRequestId: requestId,
        },
      ],
      commerce_intent: "priority_dm_followup",
      priority_dm_request_id: requestId,
    });

    expect(
      commerceOrderMetadata(
        {
          id: "session-2",
          provider: "stripe",
          metadata: {
            buyer_answers: [
              {
                question: "Priority follow-up",
                answer: "Forged question",
                priorityDmRequestId: "not-a-request-id",
              },
            ],
          },
        },
        {
          commerce_intent: "priority_dm_followup",
          priority_dm_request_id: requestId,
          stripe_checkout_session_id: "cs_123",
        },
      ),
    ).toEqual({
      stripe_checkout_session_id: "cs_123",
      buyer_answers: [{ question: "Priority follow-up", answer: "Forged question" }],
    });
  });

  it("never copies provider-supplied buyer answers into an order", () => {
    expect(
      commerceOrderMetadata(
        { id: "session-1", provider: "stripe", metadata: {} },
        {
          buyer_answers: [
            {
              question: "Priority follow-up",
              answer: "Provider-controlled question",
              priorityDmRequestId: requestId,
            },
          ],
          stripe_checkout_session_id: "cs_123",
        },
      ),
    ).toEqual({ stripe_checkout_session_id: "cs_123" });
  });

  it("preserves the paid follow-up message-table character limit", () => {
    const body = "x".repeat(10_000);
    expect(
      commerceBuyerAnswersFromSession({
        id: "session-1",
        provider: "stripe",
        metadata: { buyer_answers: [priorityDmFollowUpAnswer(requestId, body)] },
      }),
    ).toEqual([
      {
        question: "Priority follow-up",
        answer: body,
        priorityDmRequestId: requestId,
      },
    ]);
  });

  it("marks the session paid and always ensures the durable order emails exist", async () => {
    await expect(
      finalizeCommerceFulfillment({
        session: {
          id: "session-1",
          provider: "stripe",
          metadata: { access_token_ciphertext: "encrypted" },
        },
        orderId: "order-1",
        providerCheckoutId: "cs_123",
      }),
    ).resolves.toEqual({ notificationsQueued: true });
    expect(mocks.decryptServerSecret).toHaveBeenCalledWith("encrypted");
    expect(mocks.enqueueCommerceOrderEmails).toHaveBeenCalledWith({
      orderId: "order-1",
      accessToken: "private-token",
    });
  });

  it("keeps a paid order successful when email queueing is temporarily unavailable", async () => {
    mocks.enqueueCommerceOrderEmails.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      finalizeCommerceFulfillment({
        session: { id: "session-1", provider: "polar" },
        orderId: "order-1",
      }),
    ).resolves.toEqual({ notificationsQueued: false });
  });

  it("does not acknowledge fulfillment when the local payment session was not updated", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(
      finalizeCommerceFulfillment({
        session: { id: "missing", provider: "paypal" },
        orderId: "order-1",
      }),
    ).rejects.toThrow("payment session could not be finalized");
    expect(mocks.enqueueCommerceOrderEmails).not.toHaveBeenCalled();
  });
});
