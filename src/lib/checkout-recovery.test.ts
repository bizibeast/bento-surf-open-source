import { describe, expect, it } from "vitest";
import {
  clearCheckoutRecovery,
  readCheckoutRecovery,
  writeCheckoutRecovery,
} from "./checkout-recovery";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("checkout recovery", () => {
  it("restores only the safe buyer form fields for the matching product", () => {
    const storage = memoryStorage();
    writeCheckoutRecovery(
      storage,
      {
        productId: "product-a",
        email: "buyer@example.com",
        name: "Buyer",
        recordingAddon: true,
      },
      1_000,
    );

    expect(readCheckoutRecovery(storage, "product-a", 2_000)).toEqual({
      productId: "product-a",
      email: "buyer@example.com",
      name: "Buyer",
      recordingAddon: true,
      updatedAt: 1_000,
    });
    expect(readCheckoutRecovery(storage, "product-b", 2_000)).toBeNull();
    expect([...storage.values.values()].join(" ")).not.toMatch(
      /checkout_url|access_token|provider_checkout|secret/i,
    );
  });

  it("expires stale or malformed data instead of attempting to use it", () => {
    const storage = memoryStorage();
    writeCheckoutRecovery(
      storage,
      {
        productId: "product-a",
        email: "buyer@example.com",
        name: "",
        recordingAddon: false,
      },
      1_000,
    );
    expect(readCheckoutRecovery(storage, "product-a", 2 * 60 * 60 * 1_000 + 1_001)).toBeNull();

    storage.setItem("bento:checkout-recovery:product-a", "{bad json");
    expect(readCheckoutRecovery(storage, "product-a", 2_000)).toBeNull();
  });

  it("can be cleared after successful fulfillment", () => {
    const storage = memoryStorage();
    writeCheckoutRecovery(storage, {
      productId: "product-a",
      email: "buyer@example.com",
      name: "",
      recordingAddon: false,
    });
    clearCheckoutRecovery(storage, "product-a");
    expect(readCheckoutRecovery(storage, "product-a")).toBeNull();
  });

  it("never blocks checkout when browser storage is unavailable", () => {
    const unavailable = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() =>
      writeCheckoutRecovery(unavailable, {
        productId: "product-a",
        email: "buyer@example.com",
        name: "",
        recordingAddon: false,
      }),
    ).not.toThrow();
    expect(readCheckoutRecovery(unavailable, "product-a")).toBeNull();
    expect(() => clearCheckoutRecovery(unavailable, "product-a")).not.toThrow();
  });
});
