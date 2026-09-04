import { describe, expect, it } from "vitest";
import type {
  CommerceDisputeResult,
  CommerceRefundResult,
} from "./commerce-order-lifecycle.server";

describe("commerce refund lifecycle contract", () => {
  it("represents partial refunds distinctly from paid and fully refunded orders", () => {
    const result: CommerceRefundResult = {
      orderId: "order-1",
      alreadyProcessed: false,
      refundedAmount: 500,
      appliedAmount: 500,
      fullyRefunded: false,
      status: "partially_refunded",
    };

    expect(result.status).toBe("partially_refunded");
    expect(result.fullyRefunded).toBe(false);
    expect(result.appliedAmount).toBeLessThan(result.refundedAmount + 1);
  });
});

describe("commerce dispute lifecycle contract", () => {
  it("distinguishes access suspension from a favorable restoration", () => {
    const opened: CommerceDisputeResult = {
      orderId: "order-1",
      alreadyProcessed: false,
      stateApplied: true,
      disputeStatus: "open",
      status: "disputed",
      suspendedGrants: 1,
      restoredGrants: 0,
    };
    const won: CommerceDisputeResult = {
      ...opened,
      disputeStatus: "won",
      status: "paid",
      suspendedGrants: 0,
      restoredGrants: 1,
    };
    expect(opened.status).toBe("disputed");
    expect(opened.suspendedGrants).toBe(1);
    expect(won.status).toBe("paid");
    expect(won.restoredGrants).toBe(1);
  });
});
