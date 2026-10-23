import { describe, expect, it } from "vitest";
import {
  checkoutFailureMessage,
  readCheckoutReturn,
  withoutCheckoutReturnParams,
} from "./checkout-return";

describe("Dodo checkout return", () => {
  it.each(["failed", "cancelled", "expired", "FAILED"])(
    "treats status=%s as a failure",
    (status) => {
      expect(readCheckoutReturn(`?checkout=success&status=${status}`).outcome).toBe("failed");
    },
  );
  it("never reads checkout=success alone as success", () => {
    expect(readCheckoutReturn("?checkout=success").outcome).toBe("pending");
    expect(readCheckoutReturn("?checkout=return&trial=1").outcome).toBe("pending");
  });
  it.each(["processing", "requires_customer_action", "mystery"])(
    "waits for the webhook on status=%s",
    (status) => {
      expect(readCheckoutReturn(`?checkout=return&status=${status}`).outcome).toBe("pending");
    },
  );
  it.each(["active", "succeeded"])("accepts Dodo's success status %s", (status) => {
    expect(readCheckoutReturn(`?subscription_id=sub_1&status=${status}`).outcome).toBe("succeeded");
  });
  it("ignores unrelated status parameters", () => {
    expect(readCheckoutReturn("?status=failed").outcome).toBe("none");
    expect(readCheckoutReturn("").outcome).toBe("none");
  });
  it("reads the trial marker", () => {
    expect(readCheckoutReturn("?checkout=return&trial=0&status=failed").trial).toBe(false);
    expect(readCheckoutReturn("?checkout=return&trial=1&status=failed").trial).toBe(true);
  });
  it("explains that nothing was charged and the trial has not started", () => {
    const message = checkoutFailureMessage("failed", true);
    expect(message).toBe(
      "Your card didn't go through, so your trial hasn't started. Nothing was charged. Please try another card.",
    );
    for (const value of [
      message,
      checkoutFailureMessage("expired", true),
      checkoutFailureMessage("failed", false),
    ])
      expect(value).not.toMatch(/[\u2013\u2014]/);
  });
  it("strips provider parameters but keeps the rest", () => {
    expect(
      withoutCheckoutReturnParams(
        "https://app.bento.surf/settings?section=integrations&integration=payments&checkout=return&trial=1&subscription_id=sub_1&status=failed",
      ),
    ).toBe("/settings?section=integrations&integration=payments");
  });
});
