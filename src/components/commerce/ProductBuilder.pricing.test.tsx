import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProductBuilder } from "./ProductBuilder";
vi.mock("@/lib/commerce.functions", () => ({
  createCommerceProduct: vi.fn(),
  updateCommerceProduct: vi.fn(),
}));
vi.mock("@/components/blocks/FileDropzone", () => ({ FileDropzone: () => null }));
vi.mock("@/components/commerce/ProductWebsiteEditor", () => ({ ProductWebsiteEditor: () => null }));
function pricing(kind: "priority_dm" | "bundle" | "course") {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductBuilder
        kind={kind}
        open
        products={[]}
        paymentProvider={null}
        defaultCurrency="usd"
        defaultCurrencyLoading={false}
        onOpenChange={() => {}}
        onSaved={() => {}}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  return screen.getByRole("combobox", { name: "Pricing" });
}
it.each(["priority_dm", "bundle"] as const)(
  "offers only canonical one-time pricing for %s",
  (kind) => {
    const selector = pricing(kind);
    expect(within(selector).getByRole("option", { name: "One-time" })).toBeInTheDocument();
    expect(within(selector).queryByRole("option", { name: "Free" })).not.toBeInTheDocument();
    expect(within(selector).queryByRole("option", { name: "Recurring" })).not.toBeInTheDocument();
  },
);
it("keeps free and recurring pricing available for courses", () => {
  const selector = pricing("course");
  expect(within(selector).getByRole("option", { name: "Free" })).toBeInTheDocument();
  expect(within(selector).getByRole("option", { name: "Recurring" })).toBeInTheDocument();
});
