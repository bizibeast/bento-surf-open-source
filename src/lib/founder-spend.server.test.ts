import { describe, expect, it } from "vitest";
import { normalizeCloudflareCharge } from "./founder-spend.server";

describe("Cloudflare billing normalization", () => {
  it("counts paid charges in minor units without counting settlements or pending charges", () => {
    const base = {
      id: "invoice-1",
      amount: 20.99,
      currency: "USD",
      occurred_at: "2026-10-09T10:00:00Z",
    };
    expect(normalizeCloudflareCharge({ ...base, type: "charge", status: "paid" })).toMatchObject({
      amountMinor: 2099,
      currency: "USD",
    });
    expect(normalizeCloudflareCharge({ ...base, type: "payment", status: "paid" })).toBeNull();
    expect(normalizeCloudflareCharge({ ...base, type: "charge", status: "pending" })).toBeNull();
    expect(normalizeCloudflareCharge({ ...base, type: "charge", amount: -20 })).toBeNull();
  });
});
