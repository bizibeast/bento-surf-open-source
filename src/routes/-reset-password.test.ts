import { describe, expect, it } from "vitest";
import { isPasswordRecoveryHash, validateNewPassword } from "./reset-password";

describe("password recovery boundary", () => {
  it("only treats Supabase recovery links as password recovery", () => {
    expect(isPasswordRecoveryHash("#access_token=token&type=recovery")).toBe(true);
    expect(isPasswordRecoveryHash("#access_token=token&type=signup")).toBe(false);
    expect(isPasswordRecoveryHash("")).toBe(false);
  });

  it("rejects invalid new password submissions", () => {
    expect(validateNewPassword("short", "short")).toMatch(/between 8 and 128/);
    expect(validateNewPassword("a-secure-password", "different-password")).toMatch(/do not match/);
    expect(validateNewPassword("a-secure-password", "a-secure-password")).toBeNull();
  });
});
