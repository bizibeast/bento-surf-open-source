import { describe, expect, it } from "vitest";
import { isServerSecretEncryptionKeyValid } from "./secret-crypto.server";

describe("server secret encryption key validation", () => {
  it("accepts supported 32-byte encodings", () => {
    expect(isServerSecretEncryptionKeyValid("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")).toBe(
      true,
    );
    expect(isServerSecretEncryptionKeyValid(`hex:${"ab".repeat(32)}`)).toBe(true);
    expect(isServerSecretEncryptionKeyValid("ab".repeat(32))).toBe(true);
  });

  it("rejects missing, malformed, and incorrectly sized values", () => {
    expect(isServerSecretEncryptionKeyValid(undefined)).toBe(false);
    expect(isServerSecretEncryptionKeyValid("")).toBe(false);
    expect(isServerSecretEncryptionKeyValid("not-base64!")).toBe(false);
    expect(isServerSecretEncryptionKeyValid("dG9vLXNob3J0")).toBe(false);
    expect(isServerSecretEncryptionKeyValid(`hex:${"ab".repeat(31)}`)).toBe(false);
  });
});
