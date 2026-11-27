import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommerceCurrency } from "@/lib/commerce-currency";

const mocks = vi.hoisted(() => ({
  workspace: "selected-workspace",
  defaults: {} as Record<string, CommerceCurrency>,
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/commerce-currency.functions", () => ({
  getMyCommerceCurrency: mocks.get,
  setMyCommerceCurrency: mocks.set,
}));

import { ProductCurrencyPreference } from "./settings";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProductCurrencyPreference />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace = "selected-workspace";
  mocks.defaults = { "selected-workspace": "inr", "other-workspace": "usd" };
  mocks.get.mockImplementation(async () => ({ currency: mocks.defaults[mocks.workspace] }));
  mocks.set.mockImplementation(async ({ data }: { data: { currency: CommerceCurrency } }) => {
    mocks.defaults[mocks.workspace] = data.currency;
    return { currency: data.currency };
  });
});

describe("Settings product currency", () => {
  it("persists the selected workspace's default across a fresh Settings visit", async () => {
    const first = mount();
    const select = screen.getByRole("combobox", { name: "Default currency" });
    await waitFor(() => expect(select).toHaveValue("inr"));
    fireEvent.change(select, { target: { value: "eur" } });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ data: { currency: "eur" } });
    expect(mocks.defaults["other-workspace"]).toBe("usd");
    first.unmount();

    const next = mount();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Default currency" })).toHaveValue("eur"),
    );
    next.unmount();
    mocks.workspace = "other-workspace";
    mount();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Default currency" })).toBeEnabled(),
    );
    expect(screen.getByRole("combobox", { name: "Default currency" })).toHaveValue("usd");
  });

  it("explains the default applies to new products and keeps per-product currencies", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Default currency" })).toBeEnabled(),
    );
    expect(screen.getByText(/new products in this Bento workspace/)).toBeVisible();
    expect(screen.getByText(/Existing products keep their prices and currencies/)).toBeVisible();
    expect(screen.getByText(/change the currency on each product/)).toBeVisible();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
