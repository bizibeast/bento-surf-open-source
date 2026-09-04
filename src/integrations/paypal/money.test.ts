import { describe, expect, it } from "vitest";
import { paypalMinorUnits, paypalMoney } from "./money";

describe("PayPal currency amounts", () => {
  it("serializes two-decimal and zero-decimal currencies", () => {
    expect(paypalMoney(1_999, "usd")).toBe("19.99");
    expect(paypalMoney(1_999, "jpy")).toBe("1999");
    expect(paypalMinorUnits("19.99", "usd")).toBe(1_999);
    expect(paypalMinorUnits("1999", "jpy")).toBe(1_999);
  });

  it("rejects a currency PayPal checkout does not support", () => {
    expect(() => paypalMoney(1_000, "inr")).toThrow("not supported");
  });
});
