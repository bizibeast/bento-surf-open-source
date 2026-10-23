import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaymentGatewayPicker } from "@/components/settings/PaymentGatewayPicker";
import { CREATOR_PAYMENT_PROVIDER_DEFINITIONS } from "@/lib/payment-providers";
import { CONNECT_PAYMENTS_BANNER_BODY, CONNECT_PAYMENTS_BANNER_TITLE } from "@/lib/plans";

describe("PaymentGatewayPicker", () => {
  it("moves the selected indicator to the gateway the user chooses", () => {
    render(
      <PaymentGatewayPicker
        settings={{
          locked: false,
          feeBps: 0,
          selectedProvider: null,
          recommendedProvider: "dodo",
          connections: [],
          providers: CREATOR_PAYMENT_PROVIDER_DEFINITIONS.map((provider) => ({
            ...provider,
            configured: true,
          })),
        }}
        loading={false}
        onConnect={vi.fn()}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    const dodo = screen.getByRole("button", {
      name: "Connect Dodo Payments",
    });
    const stripe = screen.getByRole("button", { name: "Connect Stripe" });

    expect(document.querySelectorAll("[data-payment-provider-tile]")).toHaveLength(6);
    expect(stripe).toHaveClass("min-h-28", "rounded-xl");
    expect(dodo).toHaveAttribute("aria-pressed", "false");
    expect(stripe).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(stripe);

    expect(dodo).toHaveAttribute("aria-pressed", "false");
    expect(stripe).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog")).toHaveClass("overflow-x-hidden", "overflow-y-auto");
    expect(screen.getByRole("dialog")).not.toHaveClass("overflow-hidden");
  });

  it.each(["stripe", "dodo", "polar", "razorpay"] as const)(
    "shows the recommendation in the %s gateway dialog",
    (selectedProvider) => {
      render(
        <PaymentGatewayPicker
          settings={{
            locked: false,
            feeBps: 0,
            selectedProvider,
            recommendedProvider: "dodo",
            connections: [],
            providers: CREATOR_PAYMENT_PROVIDER_DEFINITIONS.map((provider) => ({
              ...provider,
              configured: true,
            })),
          }}
          loading={false}
          onConnect={vi.fn()}
          onRefresh={vi.fn()}
          onDisconnect={vi.fn()}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: `Connect ${CREATOR_PAYMENT_PROVIDER_DEFINITIONS.find(({ id }) => id === selectedProvider)?.name}`,
        }),
      );

      expect(screen.getByText("Recommended")).toHaveClass("rounded-lg");
    },
  );

  it.each(["creem", "paypal"] as const)(
    "hides the recommendation for the selected %s gateway",
    (selectedProvider) => {
      render(
        <PaymentGatewayPicker
          settings={{
            locked: false,
            feeBps: 0,
            selectedProvider,
            recommendedProvider: "dodo",
            connections: [],
            providers: CREATOR_PAYMENT_PROVIDER_DEFINITIONS.map((provider) => ({
              ...provider,
              configured: true,
            })),
          }}
          loading={false}
          onConnect={vi.fn()}
          onRefresh={vi.fn()}
          onDisconnect={vi.fn()}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: `Connect ${CREATOR_PAYMENT_PROVIDER_DEFINITIONS.find(({ id }) => id === selectedProvider)?.name}`,
        }),
      );

      expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
    },
  );

  it("starts checkout from a locked provider instead of opening its setup dialog", () => {
    const onLockedCheckout = vi.fn();
    render(
      <PaymentGatewayPicker
        settings={{
          locked: true,
          feeBps: 0,
          selectedProvider: null,
          recommendedProvider: "dodo",
          connections: [],
          providers: CREATOR_PAYMENT_PROVIDER_DEFINITIONS.map((provider) => ({
            ...provider,
            configured: true,
          })),
        }}
        loading={false}
        onConnect={vi.fn()}
        onLockedCheckout={onLockedCheckout}
        onRefresh={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    );

    expect(screen.getByText(CONNECT_PAYMENTS_BANNER_TITLE)).toBeVisible();
    expect(screen.getByText(CONNECT_PAYMENTS_BANNER_BODY)).toBeVisible();
    expect(CONNECT_PAYMENTS_BANNER_BODY).toContain("3-day");
    expect(`${CONNECT_PAYMENTS_BANNER_TITLE} ${CONNECT_PAYMENTS_BANNER_BODY}`).not.toMatch(
      /7-day|7 day|\u2014|\u2013/,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect Razorpay" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect PayPal" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect Creem" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));

    expect(onLockedCheckout).toHaveBeenCalledTimes(4);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
