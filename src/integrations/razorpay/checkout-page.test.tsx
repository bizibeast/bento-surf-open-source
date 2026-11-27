/* eslint-disable @typescript-eslint/no-explicit-any -- The route boundary is isolated from the router and provider. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkout: {} as any,
  verify: vi.fn(),
  options: null as any,
  open: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: any) => ({ options, useLoaderData: () => mocks.checkout }),
}));
vi.mock("./checkout.functions", () => ({
  getRazorpayCheckout: vi.fn(),
  verifyRazorpayCheckout: mocks.verify,
}));
import { Route } from "@/routes/payments.razorpay.$sessionId";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options = null;
  mocks.checkout = {
    sessionId: "session",
    orderId: null,
    subscriptionId: "sub_example",
    keyId: "rzp_test_example",
    amount: 1900,
    currency: "USD",
    buyerName: "Buyer",
    buyerEmail: "buyer@example.com",
    productTitle: "Community",
    creatorName: "Creator",
    cancelUrl: "/@creator/products/community",
    test: true,
    subscriptionTerms:
      "Renews every month for up to 120 payments (maximum 10 years), unless canceled earlier.",
  };
  window.Razorpay = vi.fn(function (options) {
    mocks.options = options;
    return { open: mocks.open };
  });
});
afterEach(() => {
  delete window.Razorpay;
});

describe("Razorpay recurring checkout page", () => {
  it("shows recurring terms before the buyer opens the payment modal", async () => {
    const Component = (Route as any).options.component;
    render(<Component />);
    expect(screen.getByText(mocks.checkout.subscriptionTerms)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue with Razorpay" })).toBeEnabled(),
    );
    expect(mocks.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue with Razorpay" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    expect(mocks.options).toMatchObject({ subscription_id: "sub_example" });
    expect(mocks.options).not.toHaveProperty("order_id");
    expect(mocks.options).not.toHaveProperty("amount");
  });

  it("shows authorization pending without opening another mandate checkout", async () => {
    mocks.verify.mockResolvedValue({
      pending: true,
      url: null,
      message: "We'll email your access link after the first subscription payment is captured.",
    });
    const Component = (Route as any).options.component;
    render(<Component />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue with Razorpay" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue with Razorpay" }));
    await waitFor(() => expect(mocks.options).not.toBeNull());
    await act(() =>
      mocks.options.handler({
        razorpay_payment_id: "pay_example",
        razorpay_subscription_id: "sub_example",
        razorpay_signature: "signature",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("first subscription payment");
    expect(screen.getByRole("button", { name: "Waiting for first payment" })).toBeDisabled();
    expect(mocks.verify.mock.calls[0][0].data).toMatchObject({
      razorpaySubscriptionId: "sub_example",
    });
  });

  it("preserves automatic one-time Order checkout", async () => {
    mocks.checkout = {
      ...mocks.checkout,
      subscriptionId: null,
      orderId: "order_example",
      subscriptionTerms: null,
    };
    const Component = (Route as any).options.component;
    render(<Component />);
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    expect(mocks.options).toMatchObject({
      order_id: "order_example",
      amount: 1900,
      currency: "USD",
    });
    expect(mocks.options).not.toHaveProperty("subscription_id");
  });
});
