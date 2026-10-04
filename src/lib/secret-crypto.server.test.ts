import { describe, expect, it } from "vitest";
import {
  decryptServerSecret,
  encryptServerSecret,
  isServerSecretEncryptionKeyValid,
} from "./secret-crypto.server";

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

  it("uses an isolated key purpose for Content provider credentials", async () => {
    const previous = process.env.CONTENT_CONNECTION_ENCRYPTION_KEY;
    process.env.CONTENT_CONNECTION_ENCRYPTION_KEY = `hex:${"cd".repeat(32)}`;
    try {
      const encrypted = await encryptServerSecret("provider-token", "content");
      await expect(decryptServerSecret(encrypted, "content")).resolves.toBe("provider-token");
    } finally {
      if (previous === undefined) delete process.env.CONTENT_CONNECTION_ENCRYPTION_KEY;
      else process.env.CONTENT_CONNECTION_ENCRYPTION_KEY = previous;
    }
  });
});
