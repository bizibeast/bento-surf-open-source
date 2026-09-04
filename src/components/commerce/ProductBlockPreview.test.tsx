import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductBlockPreview } from "./ProductBlockPreview";

const product = {
  kind: "digital_product" as const,
  title: "Creator launch guide",
  subtitle: "Build a better launch",
  cover_url: null,
  pricing_type: "one_time" as const,
  price_amount: 1900,
  currency: "usd",
  billing_interval: null,
  cta_label: "Get the guide",
};

describe("ProductBlockPreview", () => {
  it("updates the canonical visitor block renderer and previews every supported layout", () => {
    const { rerender } = render(
      <ProductBlockPreview product={product} profile={{ theme: "light", accent_color: "blue" }} />,
    );

    expect(screen.getByTestId("commerce-tile")).toHaveAttribute("data-layout", "square");
    expect(screen.getByText("Creator launch guide")).toBeInTheDocument();
    expect(screen.getByText("$19")).toBeInTheDocument();
    expect(screen.getByText("Card size")).toBeVisible();
    expect(screen.getByTestId("product-block-layouts")).toHaveClass("grid-cols-6");
    expect(screen.getByTestId("product-block-layouts")).not.toHaveClass("hidden");
    expect(screen.getByTestId("product-block-layouts")).not.toHaveClass("overflow-x-auto");

    for (const [name, layout] of [
      ["Preview Icon 1×1", "icon"],
      ["Preview Strip 4×1", "strip"],
      ["Preview Square 2×2", "square"],
      ["Preview Wide 4×2", "wide"],
      ["Preview Tall 2×4", "tall"],
      ["Preview Large 4×4", "large"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByTestId("commerce-tile")).toHaveAttribute("data-layout", layout);
    }

    rerender(
      <ProductBlockPreview
        product={{ ...product, title: "Updated live title", price_amount: 2900 }}
        profile={{ theme: "dark", accent_color: "#f97316" }}
      />,
    );
    expect(screen.getByText("Updated live title")).toBeInTheDocument();
    expect(screen.getByText("$29")).toBeInTheDocument();
    expect(
      screen.getByTestId("product-block-preview").querySelector("[data-theme]"),
    ).toHaveAttribute("data-theme", "dark");
  });
});
