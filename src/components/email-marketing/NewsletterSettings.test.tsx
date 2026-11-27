import { fireEvent, render as renderComponent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { getCreatorPaymentSettings } from "@/lib/payment-connections.functions";
import { getMyCommerceCurrency } from "@/lib/commerce-currency.functions";
import { commerceDefaultCurrencyQueryKey } from "@/lib/commerce-currency";
import { NewsletterSettings } from "./NewsletterSettings";

vi.mock("@/components/blocks/FileDropzone", () => ({
  FileDropzone: ({ label }: { label?: string }) => <div>{label}</div>,
}));

vi.mock("@/lib/payment-connections.functions", () => ({ getCreatorPaymentSettings: vi.fn() }));
vi.mock("@/lib/commerce-currency.functions", () => ({ getMyCommerceCurrency: vi.fn() }));
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...renderComponent(ui, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }),
    client,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCreatorPaymentSettings).mockResolvedValue({
    selectedProvider: "stripe",
    locked: false,
  } as never);
  vi.mocked(getMyCommerceCurrency).mockResolvedValue({ currency: "inr" });
});

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Studio Notes",
  description: "A weekly studio letter",
  sender_name: "Ari",
  reply_to_email: "ari@example.com",
  postal_address: "123 Studio Road",
  accent_color: "#3478f6",
  slug: "studio-notes",
  status: "published",
  is_default: false,
  default_template_id: "editorial" as const,
  paidProduct: { price_amount: 1200, currency: "usd", billing_interval: "month" as const },
};

describe("NewsletterSettings", () => {
  it("supports isolated test checkout only when the server explicitly allows it", async () => {
    vi.mocked(getCreatorPaymentSettings).mockResolvedValue({
      selectedProvider: null,
      stagingMockAvailable: true,
      locked: false,
    } as never);
    const save = vi.fn();
    render(
      <NewsletterSettings
        publication={publication}
        focusedPanel="paid"
        onSave={vi.fn()}
        onSavePaidOffer={save}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("Test checkout only. No payment provider is connected."),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save paid access" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save paid access" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        priceAmount: 1200,
        currency: "usd",
        billingInterval: "month",
      }),
    );
  });
  it.each(["stripe", "paypal", "razorpay", "polar", "dodo", "creem"] as const)(
    "uses the selected %s provider for paid access",
    async (provider) => {
      vi.mocked(getCreatorPaymentSettings).mockResolvedValue({
        selectedProvider: provider,
        locked: false,
      } as never);
      const onSavePaidOffer = vi.fn();
      render(
        <NewsletterSettings
          publication={publication}
          focusedPanel="paid"
          onSave={vi.fn()}
          onSavePaidOffer={onSavePaidOffer}
          onSetDefault={vi.fn()}
          onArchive={vi.fn()}
        />,
      );
      const save = screen.getByRole("button", { name: "Save paid access" });
      await waitFor(() => expect(save).toBeEnabled());
      expect(screen.getByText(/Payment provider:/)).not.toHaveTextContent("Not connected");
      expect(screen.queryByText(/Stripe is required/)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Payment settings" })).toHaveAttribute(
        "href",
        "/settings?section=integrations&integration=payments",
      );
      fireEvent.change(screen.getByRole("combobox", { name: "Billing interval" }), {
        target: { value: "year" },
      });
      fireEvent.click(save);
      await waitFor(() =>
        expect(onSavePaidOffer).toHaveBeenCalledWith({
          priceAmount: 1200,
          currency: "usd",
          billingInterval: "year",
        }),
      );
    },
  );

  it("starts new paid access with the workspace default and retains a per-offer override", async () => {
    const onSavePaidOffer = vi.fn();
    const { client } = render(
      <NewsletterSettings
        publication={{ ...publication, paidProduct: undefined }}
        focusedPanel="paid"
        onSave={vi.fn()}
        onSavePaidOffer={onSavePaidOffer}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    const currency = screen.getByRole("combobox", { name: "Currency" });
    await waitFor(() => expect(currency).toHaveValue("inr"));
    expect(screen.getAllByRole("option", { name: /^(USD|INR|EUR|GBP|AUD|CAD)$/ })).toHaveLength(6);
    fireEvent.change(currency, { target: { value: "cad" } });
    client.setQueryData(commerceDefaultCurrencyQueryKey, { currency: "eur" });
    expect(currency).toHaveValue("cad");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Paid price" }), {
      target: { value: "9" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save paid access" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save paid access" }));
    await waitFor(() =>
      expect(onSavePaidOffer).toHaveBeenCalledWith({
        priceAmount: 900,
        currency: "cad",
        billingInterval: "month",
      }),
    );
  });

  it("preserves existing paid access currency when the workspace default differs", async () => {
    render(
      <NewsletterSettings
        publication={publication}
        focusedPanel="paid"
        onSave={vi.fn()}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save paid access" })).toBeEnabled(),
    );
    expect(screen.getByRole("combobox", { name: "Currency" })).toHaveValue("usd");
    expect(getMyCommerceCurrency).not.toHaveBeenCalled();
  });

  it("waits for the saved workspace currency before a new paid offer can be saved", async () => {
    let resolveCurrency!: (value: { currency: "cad" }) => void;
    vi.mocked(getMyCommerceCurrency).mockImplementation(
      () =>
        new Promise<{ currency: "cad" }>((resolve) => {
          resolveCurrency = resolve;
        }),
    );
    render(
      <NewsletterSettings
        publication={{ ...publication, paidProduct: undefined }}
        focusedPanel="paid"
        onSave={vi.fn()}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Paid price" }), {
      target: { value: "9" },
    });
    expect(screen.getByRole("combobox", { name: "Currency" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save paid access" })).toBeDisabled();
    resolveCurrency({ currency: "cad" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save paid access" })).toBeEnabled(),
    );
    expect(screen.getByRole("combobox", { name: "Currency" })).toHaveValue("cad");
  });

  it("blocks unsupported provider currency until the offer is compatible", async () => {
    vi.mocked(getCreatorPaymentSettings).mockResolvedValue({
      selectedProvider: "paypal",
      locked: false,
    } as never);
    render(
      <NewsletterSettings
        publication={publication}
        focusedPanel="paid"
        onSave={vi.fn()}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save paid access" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Currency" }), {
      target: { value: "inr" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("INR is not supported by PayPal");
    expect(screen.getByRole("button", { name: "Save paid access" })).toBeDisabled();
  });

  it("offers payment setup when no ready provider is selected", async () => {
    vi.mocked(getCreatorPaymentSettings).mockResolvedValue({
      selectedProvider: null,
      locked: false,
    } as never);
    render(
      <NewsletterSettings
        publication={publication}
        focusedPanel="paid"
        onSave={vi.fn()}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connect a supported payment gateway",
    );
    expect(screen.getByRole("button", { name: "Save paid access" })).toBeDisabled();
  });

  it("keeps publication controls separated and requires the title to archive", () => {
    const onArchive = vi.fn();
    render(
      <NewsletterSettings
        publication={publication}
        onSave={vi.fn()}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={onArchive}
      />,
    );

    expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
    expect(screen.getByText("Upload a square (1:1) image for the best result.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Subscription & payment" }));
    expect(screen.getByRole("heading", { name: "Subscription & payment" })).toBeVisible();
    expect(screen.getByText(/Bento fee.*payment provider’s processing fees/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("button", { name: "Archive publication" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type Studio Notes to archive"), {
      target: { value: "Studio Notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Archive publication" }));
    expect(onArchive).toHaveBeenCalledWith("Studio Notes");
  });

  it("initializes and synchronizes exact SEO and template panels", () => {
    const onFocusedPanelChange = vi.fn();
    const view = render(
      <NewsletterSettings
        publication={publication}
        creatorUsername="ari"
        focusedPanel="seo"
        onFocusedPanelChange={onFocusedPanelChange}
        onSave={vi.fn()}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Website" })).toBeVisible();
    expect(screen.getByLabelText("Search result preview")).toHaveTextContent(
      "http://localhost:8080/@ari/newsletters/studio-notes",
    );
    expect(screen.getByLabelText("Search result preview")).toHaveTextContent("Studio Notes");

    view.rerender(
      <NewsletterSettings
        publication={publication}
        creatorUsername="ari"
        focusedPanel="email"
        onFocusedPanelChange={onFocusedPanelChange}
        onSave={vi.fn()}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Email defaults" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Branding" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Default template" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(onFocusedPanelChange).toHaveBeenCalledWith("details");
  });

  it("shows saving state and retains a server error", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Settings service unavailable"));
    const { container } = render(
      <NewsletterSettings
        publication={publication}
        onSave={onSave}
        onSavePaidOffer={vi.fn()}
        onSetDefault={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(container.firstChild).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Settings service unavailable"),
    );
    expect(container.firstChild).toHaveAttribute("aria-busy", "false");
    fireEvent.click(screen.getByRole("button", { name: "Email defaults" }));
    expect(screen.getByRole("status")).toHaveTextContent("Settings service unavailable");
  });
});
