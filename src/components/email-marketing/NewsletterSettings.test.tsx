import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewsletterSettings } from "./NewsletterSettings";

vi.mock("@/components/blocks/FileDropzone", () => ({
  FileDropzone: ({ label }: { label?: string }) => <div>{label}</div>,
}));

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
    expect(screen.getByText(/Bento fee.*Stripe processing fees/i)).toBeVisible();
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
