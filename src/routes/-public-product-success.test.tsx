import type { ComponentType, CSSProperties, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  loaderData: undefined as unknown,
  access: "a".repeat(43) as string | undefined,
  order: "33333333-3333-4333-8333-333333333333",
  confirmation: vi.fn(),
  accessStatus: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => ({
    ...options,
    useLoaderData: () => state.loaderData,
    useSearch: () => ({ order: state.order, access: state.access }),
  }),
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params?: { token?: string };
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
  }) => (
    <a href={to.replace("$token", params?.token || "")} {...props}>
      {children}
    </a>
  ),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/commerce.functions", () => ({
  getCommerceAccess: state.accessStatus,
  getCommerceOrderConfirmation: state.confirmation,
  getPublicCommerceProduct: vi.fn(),
}));

import { Route } from "./$username_.products.$productSlug_.success";

const productId = "11111111-1111-4111-8111-111111111111";
const Page = (Route as unknown as { component: ComponentType }).component;
let client: QueryClient;

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  state.access = "a".repeat(43);
  state.loaderData = {
    creator: {
      username: "studio",
      display_name: "Studio",
      primary_font: "Inter",
      secondary_font: "Instrument Serif",
    },
    chrome: {
      creator: {
        theme: "dark",
        accent_color: "rose",
        primary_font: "Manrope",
        secondary_font: "Lora",
        pattern: "none",
      },
      pages: [],
      customDomain: null,
    },
    product: {
      id: productId,
      kind: "course",
      title: "Free creator course",
      public_slug: "free-course",
      pricing_type: "free",
      settings: { website: { accent: "#00ff00", background: "white", font: "sans" } },
    },
  };
  state.confirmation.mockResolvedValue({
    state: "confirmed",
    orderId: state.order,
    priorityDmRequestId: null,
    accessToken: null,
  });
  state.accessStatus.mockResolvedValue({ product: { id: productId } });
  window.history.replaceState(
    {},
    "",
    `/@studio/products/free-course/success?order=${state.order}&access=${state.access}`,
  );
});
afterEach(() => {
  cleanup();
  client?.clear();
  document.querySelectorAll('link[id^="gf-"]').forEach((link) => link.remove());
});

describe("public purchase confirmation", () => {
  it("opens a first free purchase using its explicit capability when confirmation cannot recover free access, with the creator's Link theme", async () => {
    const { container } = mount();
    const open = await screen.findByRole("link", { name: "Open my purchase" }, { timeout: 10_000 });
    expect(open).toHaveAttribute("href", "/access/" + "a".repeat(43));
    expect(window.sessionStorage.getItem("bento:purchase-access:" + state.order)).toBe(
      "a".repeat(43),
    );
    expect(window.sessionStorage.getItem("bento:product-access:" + productId)).toBe("a".repeat(43));
    expect(new URL(window.location.href).searchParams.has("access")).toBe(false);
    const root = container.querySelector<HTMLElement>("[data-product-website]");
    expect(root).toHaveAttribute("data-theme", "dark");
    expect(root).toHaveClass("dark");
    expect(root?.style.getPropertyValue("--product-accent")).toBe("#f43f5e");
    expect(root?.style.getPropertyValue("--font-sans")).toContain('"Manrope"');
    expect(root?.style.getPropertyValue("--font-display")).toContain('"Lora"');
    expect(root?.getAttribute("style")).not.toContain("#00ff00");
    expect(open.style.background).toBe("var(--product-accent)");
    expect(open.style.color).toBe("var(--product-on-accent)");
  });

  it("does not open private access before the financial order is confirmed", async () => {
    state.confirmation.mockResolvedValue({
      state: "processing",
      orderId: null,
      priorityDmRequestId: null,
      accessToken: null,
    });
    mount();
    await screen.findByText("Checking secure payment…");
    await waitFor(() => expect(state.confirmation).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link", { name: "Open my purchase" })).toBeNull();
    expect(state.accessStatus).not.toHaveBeenCalled();
  });

  it("does not link to a capability for a different product", async () => {
    state.accessStatus.mockResolvedValue({ product: { id: "different-product" } });
    mount();
    await screen.findByText("Preparing private access…");
    await waitFor(() => expect(state.accessStatus).toHaveBeenCalledOnce());
    expect(screen.queryByRole("link", { name: "Open my purchase" })).toBeNull();
  });
});
