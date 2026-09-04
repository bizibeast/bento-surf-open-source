import { describe, expect, it } from "vitest";
import { DEFAULT_EMAIL_PREFERENCES } from "./email-preferences.functions";

describe("email preference defaults", () => {
  it("enables every optional email category for new users", () => {
    expect(DEFAULT_EMAIL_PREFERENCES).toEqual({
      productUpdates: true,
      weeklyDigest: true,
      marketingUnsubscribed: false,
    });
  });
});
