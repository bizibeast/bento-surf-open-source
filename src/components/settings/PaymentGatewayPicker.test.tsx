import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaymentGatewayPicker } from "@/components/settings/PaymentGatewayPicker";
import { CREATOR_PAYMENT_PROVIDER_DEFINITIONS } from "@/lib/payment-providers";

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
        upgrade={null}
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
          upgrade={null}
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
          upgrade={null}
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
});
