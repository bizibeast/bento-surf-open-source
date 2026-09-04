import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  failureReasonForResendEvent,
  recipientStatusForResendEvent,
  verifyResendWebhook,
} from "./resend-webhook.server";

const secret = `whsec_${btoa("a secure webhook signing key for bento")}`;

afterEach(() => {
  delete process.env.RESEND_WEBHOOK_SECRET;
});

describe("Resend webhook verification", () => {
  it("maps provider lifecycle events to tracked campaign recipient states", () => {
    expect(recipientStatusForResendEvent("email.sent")).toBe("sent");
    expect(recipientStatusForResendEvent("email.delivered")).toBe("delivered");
    expect(recipientStatusForResendEvent("email.bounced")).toBe("bounced");
    expect(recipientStatusForResendEvent("email.complained")).toBe("complained");
    expect(recipientStatusForResendEvent("email.failed")).toBe("failed");
    expect(recipientStatusForResendEvent("email.suppressed")).toBe("suppressed");
    expect(recipientStatusForResendEvent("email.opened")).toBeNull();
  });

  it("preserves Resend failure and suppression detail for terminal states", () => {
    expect(
      failureReasonForResendEvent({
        type: "email.failed",
        created_at: "2026-08-31T00:00:00.000Z",
        data: { error: { message: "Mailbox rejected" } },
      }),
    ).toBe("Mailbox rejected");
    expect(
      failureReasonForResendEvent({
        type: "email.suppressed",
        created_at: "2026-08-31T00:00:00.000Z",
        data: { reason: "Previous complaint" },
      }),
    ).toBe("Previous complaint");
  });

  it("accepts an authentic raw payload", () => {
    process.env.RESEND_WEBHOOK_SECRET = secret;
    const payload = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: "email_123", to: ["creator@example.com"] },
    });
    const id = "msg_123";
    const timestamp = new Date();
    const signature = new Webhook(secret).sign(id, timestamp, payload);
    const headers = new Headers({
      "svix-id": id,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1_000).toString(),
      "svix-signature": signature,
    });

    expect(verifyResendWebhook(payload, headers).type).toBe("email.delivered");
  });

  it("rejects a modified payload", () => {
    process.env.RESEND_WEBHOOK_SECRET = secret;
    const original = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
    });
    const id = "msg_456";
    const timestamp = new Date();
    const signature = new Webhook(secret).sign(id, timestamp, original);
    const headers = new Headers({
      "svix-id": id,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1_000).toString(),
      "svix-signature": signature,
    });

    expect(() => verifyResendWebhook(`${original} `, headers)).toThrow();
  });
});
