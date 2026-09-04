import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewsletterPreview } from "./NewsletterPreview";

const content = [
  { id: "heading", type: "heading" as const, text: "Launch notes" },
  { id: "secret", type: "paragraph" as const, text: "The full paid post body." },
];

const paidProduct = {
  title: "Studio Notes membership",
  url: "/@ari/products/studio-notes",
};

afterEach(() => vi.unstubAllEnvs());

function renderPreview(
  webVisibility: "private" | "public" | "paid" = "public",
  product: typeof paidProduct | null = null,
) {
  return render(
    <NewsletterPreview
      subject="Launch day"
      previewText="A first look"
      content={content}
      products={[]}
      templateId="personal-note"
      publicationName="Studio Notes"
      postalAddress="Bengaluru, India"
      webVisibility={webVisibility}
      paidProduct={product}
    />,
  );
}

describe("NewsletterPreview", () => {
  it("uses the configured public origin in email previews", () => {
    vi.stubEnv("VITE_PUBLIC_URL", "https://public.example");
    renderPreview();

    const source = screen.getByTitle("Email desktop preview").getAttribute("srcdoc") ?? "";
    expect(source).toContain("https://public.example/branding/bento-logo.png");
    expect(source).not.toContain("https://bento.surf");
  });

  it("uses the production email shell at exact desktop and mobile widths", () => {
    renderPreview();

    expect(screen.getByRole("tab", { name: "Email desktop" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("newsletter-preview-canvas")).toHaveStyle({ width: "600px" });
    const frame = screen.getByTitle("Email desktop preview");
    expect(frame.getAttribute("srcdoc")).toContain("bento-shell");
    expect(frame.getAttribute("srcdoc")).toContain("Launch notes");
    expect(frame.getAttribute("srcdoc")).toContain("Bengaluru, India");

    fireEvent.click(screen.getByRole("tab", { name: "Email mobile" }));
    expect(screen.getByRole("tab", { name: "Email mobile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("newsletter-preview-canvas")).toHaveStyle({ width: "390px" });
    expect(screen.getByTitle("Email mobile preview")).toBeVisible();
  });

  it("switches modes with arrow keys and renders the existing web document at 672px", () => {
    renderPreview();
    const desktop = screen.getByRole("tab", { name: "Email desktop" });
    desktop.focus();
    fireEvent.keyDown(desktop, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Email mobile" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Email mobile" }), {
      key: "ArrowRight",
    });

    expect(screen.getByRole("tab", { name: "Web page" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("newsletter-preview-canvas")).toHaveStyle({ width: "672px" });
    expect(screen.getByRole("article")).toHaveTextContent("The full paid post body.");
    expect(screen.getByRole("article")).toHaveStyle({ backgroundColor: "#fffaf0" });
  });

  it("reuses the production paid post paywall with real product data", () => {
    renderPreview("paid", paidProduct);
    expect(screen.getByTitle("Email desktop preview").getAttribute("srcdoc")).toContain(
      "The full paid post body.",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Web page" }));
    expect(screen.getByText("Paid post")).toBeVisible();
    expect(screen.getByRole("article")).toHaveTextContent("Launch day");
    expect(screen.getByRole("article")).toHaveTextContent("A first look");
    expect(
      screen.getByRole("link", { name: "Subscribe to Studio Notes membership" }),
    ).toHaveAttribute("href", "/@ari/products/studio-notes");
    expect(screen.queryByText("The full paid post body.")).toBeNull();
  });

  it("uses the production unavailable state when paid product data is missing", () => {
    renderPreview("paid");
    fireEvent.click(screen.getByRole("tab", { name: "Web page" }));

    expect(screen.getByRole("article")).toHaveTextContent("Paid post unavailable");
    expect(screen.queryByText("The full paid post body.")).toBeNull();
    expect(screen.queryByRole("link", { name: /Subscribe to/ })).toBeNull();
  });
});
