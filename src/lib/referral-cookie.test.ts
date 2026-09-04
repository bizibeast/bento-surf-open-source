import { describe, expect, it } from "vitest";
import { referralCookieSettings } from "./referral.server";

describe("referral cookie scope", () => {
  it("keeps referral cookies host-only by default", () => {
    expect(referralCookieSettings(true)).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  });

  it("uses the same validated configured domain for set and delete paths", () => {
    expect(referralCookieSettings(true, " .accounts.example.com ")).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      domain: "accounts.example.com",
    });
    expect(() => referralCookieSettings(true, "https://example.com/path")).toThrow(
      "without a path",
    );
  });
});
