import { describe, expect, it } from "vitest";
import { socialApiErrorMessage, socialApiPayloadHasError } from "./social-provider-response";

describe("socialApiPayloadHasError", () => {
  it("treats TikTok success payloads with error.code ok as success", () => {
    expect(
      socialApiPayloadHasError({
        data: { user: { open_id: "abc" } },
        error: { code: "ok", message: "", log_id: "1" },
      }),
    ).toBe(false);
    expect(socialApiPayloadHasError({ error: { code: 0, message: "" } })).toBe(false);
    expect(socialApiPayloadHasError({ error: { code: "0", message: "" } })).toBe(false);
  });

  it("treats string and non-ok object errors as failures", () => {
    expect(socialApiPayloadHasError({ error: "invalid_grant" })).toBe(true);
    expect(
      socialApiPayloadHasError({
        error: { code: "access_token_invalid", message: "bad token" },
      }),
    ).toBe(true);
  });
});

describe("socialApiErrorMessage", () => {
  it("prefers provider descriptions and TikTok messages", () => {
    expect(
      socialApiErrorMessage(
        { error: "invalid_grant", error_description: "Authorization code is expired." },
        "fallback",
      ),
    ).toBe("Authorization code is expired.");
    expect(
      socialApiErrorMessage({ error: { code: "x", message: "Scope missing" } }, "fallback"),
    ).toBe("Scope missing");
    expect(socialApiErrorMessage({}, "fallback")).toBe("fallback");
  });
});
