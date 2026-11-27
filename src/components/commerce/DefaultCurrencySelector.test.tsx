import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMyCommerceCurrency, setMyCommerceCurrency } from "@/lib/commerce-currency.functions";
import { commerceDefaultCurrencyQueryKey } from "@/lib/commerce-currency";
import { DefaultCurrencySelector } from "./DefaultCurrencySelector";

vi.mock("@/lib/commerce-currency.functions", () => ({
  getMyCommerceCurrency: vi.fn(),
  setMyCommerceCurrency: vi.fn(),
}));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <DefaultCurrencySelector />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMyCommerceCurrency).mockResolvedValue({ currency: "inr" });
  vi.mocked(setMyCommerceCurrency).mockResolvedValue({ currency: "eur" });
});

describe("DefaultCurrencySelector", () => {
  it("loads the saved choice and shares a successful change with new product drafts", async () => {
    const { client } = mount();
    const select = screen.getByRole("combobox", { name: "Default currency" });
    await waitFor(() => expect(select).toHaveValue("inr"));
    expect(screen.getAllByRole("option")).toHaveLength(6);
    fireEvent.change(select, { target: { value: "eur" } });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(setMyCommerceCurrency).toHaveBeenCalledExactlyOnceWith({ data: { currency: "eur" } });
    expect(client.getQueryData(commerceDefaultCurrencyQueryKey)).toEqual({ currency: "eur" });
    expect(select).toHaveValue("eur");
    expect(screen.getByText(/For new products/)).toBeInTheDocument();
  });

  it("retains the saved default when saving fails and allows retry", async () => {
    vi.mocked(setMyCommerceCurrency).mockRejectedValueOnce(new Error("offline"));
    const { client } = mount();
    const select = screen.getByRole("combobox", { name: "Default currency" });
    await waitFor(() => expect(select).toHaveValue("inr"));
    fireEvent.change(select, { target: { value: "eur" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(client.getQueryData(commerceDefaultCurrencyQueryKey)).toEqual({ currency: "inr" });
    expect(select).toHaveValue("inr");
    fireEvent.change(select, { target: { value: "eur" } });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("blocks changes until the stored default is loaded and offers a load retry", async () => {
    vi.mocked(getMyCommerceCurrency).mockRejectedValueOnce(new Error("offline"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("could not load");
    expect(screen.getByRole("combobox", { name: "Default currency" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Default currency" })).toHaveValue("inr"),
    );
    expect(setMyCommerceCurrency).not.toHaveBeenCalled();
  });
});
