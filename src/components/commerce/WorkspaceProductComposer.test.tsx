import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getMyCommerce, createCommerceProduct } from "@/lib/commerce.functions";
import { getMyCommerceCurrency } from "@/lib/commerce-currency.functions";
import { WorkspaceProductComposer } from "./WorkspaceProductComposer";
vi.mock("@/lib/commerce.functions", () => ({
  getMyCommerce: vi.fn(),
  createCommerceProduct: vi.fn(),
  updateCommerceProduct: vi.fn(),
}));
vi.mock("@/lib/profile.functions", () => ({
  getMyProfile: vi.fn().mockResolvedValue({ theme: "light", accent_color: "#f00" }),
}));
vi.mock("@/lib/commerce-currency.functions", () => ({ getMyCommerceCurrency: vi.fn() }));
vi.mock("@/lib/booking.functions", () => ({ getBookingAvailabilityDefaults: vi.fn() }));
vi.mock("@/components/blocks/FileDropzone", () => ({ FileDropzone: () => null }));
vi.mock("@/components/commerce/ProductWebsiteEditor", () => ({
  ProductWebsiteEditor: () => <div>Sales page editor</div>,
}));
const onSaved = vi.fn();
const onOpenChange = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.mocked(getMyCommerce).mockResolvedValue({
    products: [],
    locked: false,
    storeSetup: { selectedProvider: "stripe" },
  } as never);
  vi.mocked(getMyCommerceCurrency).mockResolvedValue({ currency: "inr" });
  vi.mocked(createCommerceProduct).mockImplementation(async (input) => {
    const { data } = input as { data: { product: Record<string, unknown> } };
    return {
      product: { ...data.product, id: "created-product" },
      block: { id: "created-block" },
    } as never;
  });
});
function renderComposer(props: Partial<Parameters<typeof WorkspaceProductComposer>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <WorkspaceProductComposer
        kind="course"
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
it("creates a free course with its lessons using the workspace currency and reports the saved product", async () => {
  renderComposer();
  fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
    target: { value: "My course" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
    target: { value: "Learn everything" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("combobox", { name: "Currency" })).toHaveValue("inr");
  fireEvent.change(screen.getByRole("combobox", { name: "Pricing" }), {
    target: { value: "free" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Add lesson" }));
  fireEvent.change(screen.getByPlaceholderText("Lesson title"), {
    target: { value: "Getting started" },
  });
  fireEvent.change(
    screen.getByPlaceholderText(
      "Write the lesson content. You can also add a resource link below.",
    ),
    { target: { value: "Your first lesson" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Create product" }));
  await waitFor(() =>
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "created-product",
        pricing_type: "free",
        currency: "inr",
        settings: expect.objectContaining({
          lessons: [
            expect.objectContaining({ title: "Getting started", body: "Your first lesson" }),
          ],
        }),
      }),
    ),
  );
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
it("never turns a missing edit target into a new product", async () => {
  renderComposer({ productId: "missing-product" });
  expect(await screen.findByRole("alert")).toHaveTextContent(/not found/i);
  expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
  expect(createCommerceProduct).not.toHaveBeenCalled();
});
it("keeps paid-newsletter mutations out of the generic product builder", async () => {
  renderComposer({ kind: "newsletter" });
  expect(await screen.findByRole("alert")).toHaveTextContent(/newsletter/i);
  expect(createCommerceProduct).not.toHaveBeenCalled();
});
it("blocks product creation for a locked workspace", async () => {
  vi.mocked(getMyCommerce).mockResolvedValue({ products: [], locked: true } as never);
  renderComposer();
  expect(await screen.findByRole("alert")).toHaveTextContent(/Store plan/i);
  expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
});

it("allows archived paid course edits without a connected gateway and preserves its existing currency", async () => {
  const product = {
    id: "archived-course",
    kind: "course",
    status: "archived",
    slug: "course",
    public_slug: "course",
    title: "Archived course",
    subtitle: "Course",
    description: "Saved course content",
    cover_url: null,
    pricing_type: "one_time",
    price_amount: 1900,
    currency: "eur",
    billing_interval: null,
    cta_label: "Read",
    inventory_limit: null,
    noindex: true,
    sales_count: 0,
    settings: { lessons: [] },
  };
  vi.mocked(getMyCommerce).mockResolvedValue({
    products: [product],
    locked: false,
    storeSetup: { selectedProvider: null },
  } as never);
  renderComposer({ productId: product.id });
  await screen.findByRole("textbox", { name: "Title" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("combobox", { name: "Currency" })).toHaveValue("eur");
  expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("preserves unsaved draft fields when a background data refresh fails", async () => {
  const { client } = renderComposer();
  const title = await screen.findByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Keep my unsaved course" } });
  vi.mocked(getMyCommerce).mockRejectedValueOnce(new Error("Temporary network failure"));
  await act(async () => {
    await client.refetchQueries({ queryKey: ["my-commerce"] });
    // Flush the query notification before checking the editor so this cannot
    // pass against the previous render while its unmount is still scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(client.getQueryState(["my-commerce"])).toMatchObject({
    status: "error",
    fetchStatus: "idle",
  });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Keep my unsaved course");
});

it("keeps an in-progress new product when the workspace currency preference refreshes", async () => {
  const { client } = renderComposer();
  const title = await screen.findByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Keep my lesson plan" } });
  await act(async () => {
    client.setQueryData(["commerce-default-currency"], { currency: "eur" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(client.getQueryData(["commerce-default-currency"])).toEqual({ currency: "eur" });
  expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Keep my lesson plan");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("combobox", { name: "Currency" })).toHaveValue("inr");
});
