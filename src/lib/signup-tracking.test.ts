import { expect, it } from "vitest";
import { createSignupTracking, redactSignupMessage, signupFailureReason } from "./signup-tracking";
it.each([
  ["Failed for USER@EXAMPLE.COM", ["user@example.com"], "Failed for [redacted]"],
  ["Failed for other@example.com", ["user@example.com"], "Failed for [redacted]"],
  ["Password Pa$$[word].* rejected: pa$$[WORD].*", ["Pa$$[word].*"], "Password [redacted] rejected: [redacted]"],
  ["No secrets here", [""], "No secrets here"],
])("redacts signup messages", (message, secrets, expected) => {
  expect(redactSignupMessage(message, secrets)).toBe(expected);
});
it("truncates signup messages after redaction", () => {
  expect(redactSignupMessage(`secret ${"x".repeat(200)}`, ["secret"]))
    .toBe(`[redacted] ${"x".repeat(149)}`);
});
it.each([
  [{ status: 429 }, "rate_limited"],
  [{ message: "Error sending email" }, "email_send_failed"],
  [{ code: "weak_password" }, "weak_password"],
  [new TypeError("Load failed"), "network"],
  [new Error("Unknown"), "other"],
])("classifies signup errors", (error, reason) => {
  expect(signupFailureReason(error)).toBe(reason);
});
it("reports only booleans for credentials, once, and suppresses successful exits", () => {
  const tracking = createSignupTracking(1000);
  tracking.google();
  expect(tracking.leave("account", true, true, 2000)).toBeNull();
  tracking.failed();
  expect(tracking.leave("account", true, false, 3000)).toEqual({
    step: "account",
    seconds_on_page: 2,
    email_entered: true,
    password_entered: false,
    google_clicked: true,
  });
  expect(tracking.leave("account", true, false, 4000)).toBeNull();
  const success = createSignupTracking(0);
  success.succeeded();
  expect(success.leave("confirmation", true, true, 4000)).toBeNull();
});
