import { expect, it } from "vitest";
import { summarizeBusinessOrders } from "./content-business-context.server";
it("keeps currencies separate and subtracts refunds from observed gross revenue", () => {
  expect(
    summarizeBusinessOrders([
      { product_id: "a", currency: "usd", gross_amount: 1000, refunded_amount: 200 },
      { product_id: "a", currency: "usd", gross_amount: 500, refunded_amount: 500 },
      { product_id: "a", currency: "inr", gross_amount: 2000, refunded_amount: 0 },
    ]),
  ).toEqual([
    {
      productId: "a",
      currency: "usd",
      orders: 2,
      grossAmount: 1500,
      refundedAmount: 700,
      revenueAfterRefunds: 800,
    },
    {
      productId: "a",
      currency: "inr",
      orders: 1,
      grossAmount: 2000,
      refundedAmount: 0,
      revenueAfterRefunds: 2000,
    },
  ]);
});
