import { describe, expect, it, vi } from "vitest";
import { commerceAccessTokenFromConfirmation } from "./commerce.functions";

describe("commerce confirmation access recovery", () => {
  it("returns only plausible tokens from confirmed encrypted sessions", async () => {
    const token = "a".repeat(43);
    const decrypt = vi.fn().mockResolvedValue(token);

    await expect(
      commerceAccessTokenFromConfirmation(
        "confirmed",
        { access_token_ciphertext: "encrypted" },
        decrypt,
      ),
    ).resolves.toBe(token);
    await expect(
      commerceAccessTokenFromConfirmation(
        "processing",
        { access_token_ciphertext: "encrypted" },
        decrypt,
      ),
    ).resolves.toBeNull();
    expect(decrypt).toHaveBeenCalledOnce();
  });
});
