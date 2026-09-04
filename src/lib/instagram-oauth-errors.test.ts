import { describe, expect, it } from "vitest";
import {
  instagramOAuthFailureFromUnknown,
  instagramOAuthFailureMessage,
} from "./instagram-oauth-errors";

describe("instagramOAuthFailureMessage", () => {
  it("explains a cancelled OAuth grant without retaining access", () => {
    expect(
      instagramOAuthFailureMessage({
        error: "access_denied",
        errorDescription: "The user denied your request",
      }),
    ).toBe("Instagram connection was cancelled. No account access was saved.");
  });

  it("explains Meta App Review and test-account restrictions", () => {
    expect(
      instagramOAuthFailureMessage({
        error: "invalid_scope",
        errorDescription: "Invalid Scopes: instagram_business_manage_messages",
      }),
    ).toContain("only accounts assigned as Meta testers can connect");
  });

  it("requires a professional Instagram account when Meta rejects the account type", () => {
    expect(
      instagramOAuthFailureMessage({
        error: "unsupported_account",
        errorDescription: "This is not a professional account",
      }),
    ).toContain("Instagram Business or Creator account");
  });

  it("preserves audited server recovery messages", () => {
    expect(
      instagramOAuthFailureMessage({
        failureMessage: "This Instagram connection link expired. Please start again.",
      }),
    ).toBe("This Instagram connection link expired. Please start again.");
  });

  it("does not expose unknown provider or server details", () => {
    expect(
      instagramOAuthFailureMessage({
        error: "server_error",
        errorDescription: "Internal trace secret=example",
      }),
    ).toBe("Instagram could not be connected. Return to Auto DMs and try again.");
    expect(
      instagramOAuthFailureMessage({
        failureMessage: "Database statement failed: private detail",
      }),
    ).toBe("Instagram could not be connected. Return to Auto DMs and try again.");
  });

  it("handles an incomplete callback", () => {
    expect(instagramOAuthFailureMessage({})).toBe(
      "Instagram did not return a valid connection. Start the connection again.",
    );
  });

  it("reads safe messages from serialized server errors", () => {
    expect(
      instagramOAuthFailureFromUnknown({
        message: "Instagram did not return an account profile. Please reconnect and try again.",
      }),
    ).toBe("Instagram did not return an account profile. Please reconnect and try again.");
  });

  it("does not expose unknown serialized server errors", () => {
    expect(
      instagramOAuthFailureFromUnknown({
        message: "Database statement failed: private detail",
      }),
    ).toBe("Instagram could not be connected. Return to Auto DMs and try again.");
  });
});
