import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PublicProductTheme } from "./PublicProductTheme";
import { PublicCreatorShell } from "./PublicCreatorShell";
import type { PublicCreatorChrome } from "@/lib/public-creator-chrome.server";

afterEach(() => {
  cleanup();
  document.querySelectorAll('link[id^="gf-"]').forEach((link) => link.remove());
});

it("scopes product colors, theme and both creator fonts around the product content", () => {
  const { container } = render(
    <PublicProductTheme
      creator={{
        theme: "dark",
        accent_color: "rose",
        primary_font: "Manrope",
        secondary_font: "Lora",
      }}
      className="pb-24"
    >
      <h1>Creator product</h1>
      <button>Buy access</button>
    </PublicProductTheme>,
  );
  const root = container.querySelector<HTMLElement>("[data-product-website]")!;
  expect(root).toHaveAttribute("data-bento-public-page", "true");
  expect(root).toHaveAttribute("data-theme", "dark");
  expect(root).toHaveClass("dark", "pb-24");
  expect(root.style.getPropertyValue("--product-accent")).toBe("#f43f5e");
  expect(root.style.getPropertyValue("--font-sans")).toContain('"Manrope"');
  expect(root.style.getPropertyValue("--font-display")).toContain('"Lora"');
  expect(document.getElementById("gf-Manrope")?.getAttribute("href")).toContain("family=Manrope");
  expect(document.getElementById("gf-Lora")?.getAttribute("href")).toContain("family=Lora");
  expect(screen.getByRole("heading", { name: "Creator product" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Buy access" })).toBeVisible();
});

it("renders the same custom photo backdrop and follows subsequent creator Link changes", () => {
  const { container, rerender } = render(
    <PublicProductTheme
      creator={{
        theme: "dark",
        accent_color: "#84cc16",
        pattern: "custom_photo",
        pattern_settings: { image_url: "https://example.com/creator-background.jpg", opacity: 100 },
      }}
    >
      Product layout
    </PublicProductTheme>,
  );
  expect(
    container.querySelector<HTMLElement>('[style*="background-image"]')?.style.backgroundImage,
  ).toContain("https://example.com/creator-background.jpg");
  rerender(
    <PublicProductTheme creator={{ theme: "light", accent_color: "sky", primary_font: "Inter" }}>
      Product layout
    </PublicProductTheme>,
  );
  const root = container.querySelector<HTMLElement>("[data-product-website]")!;
  expect(root).toHaveAttribute("data-theme", "light");
  expect(root).not.toHaveClass("dark");
  expect(root.style.getPropertyValue("--product-accent")).toBe("#0ea5e9");
  expect(root.style.getPropertyValue("--background")).toBe(
    "color-mix(in oklab, #0ea5e9 8%, #ffffff)",
  );
  expect(container.querySelector('[style*="background-image"]')).toBeNull();
});

it("matches the actual public Link shell's background and surfaces", () => {
  const creator = {
    username: "creator",
    display_name: "Creator",
    theme: "dark",
    accent_color: "#123456",
    pattern: "none",
    header_mode: "no_banner",
    badge_hidden: true,
  };
  const { container } = render(
    <>
      <PublicCreatorShell
        chrome={{ creator, pages: [], customDomain: null } as unknown as PublicCreatorChrome}
        activePageId={null}
      >
        Link page
      </PublicCreatorShell>
      <PublicProductTheme creator={creator}>Product page</PublicProductTheme>
    </>,
  );
  const [link, product] = container.querySelectorAll<HTMLElement>("[data-bento-public-page]");
  for (const token of ["--background", "--card", "--muted", "--accent", "--primary", "--border"]) {
    expect(product.style.getPropertyValue(token), token).toBe(link.style.getPropertyValue(token));
  }
});
