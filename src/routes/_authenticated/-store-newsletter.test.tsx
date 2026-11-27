import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMyNewsletterPublications } from "@/lib/newsletter.functions";
import { getMyCommerce } from "@/lib/commerce.functions";
import { getMyProfile } from "@/lib/profile.functions";
import { deleteCommerceProduct } from "@/lib/commerce-delete.functions";
import { getMyCommerceCurrency } from "@/lib/commerce-currency.functions";

const navigate = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({
  tab: "products",
  create: undefined as string | undefined,
  edit: undefined as string | undefined,
}));
vi.mock("@/lib/commerce-currency.functions", () => ({
  getMyCommerceCurrency: vi.fn().mockResolvedValue({ currency: "usd" }),
  setMyCommerceCurrency: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    options,
    useSearch: () => routeState,
  }),
  useNavigate: () => navigate,
  Link: ({
    to,
    search,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => (
    <a href={`${to}${search ? `?${new URLSearchParams(search).toString()}` : ""}`} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/newsletter.functions", () => ({
  getMyNewsletterPublications: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/components/commerce/NewsletterProductBuilder", () => ({
  NewsletterProductBuilder: ({ open, publicationId }: { open: boolean; publicationId?: string }) =>
    open ? <div role="dialog">Canonical newsletter builder {publicationId}</div> : null,
}));
vi.mock("@/lib/commerce.functions", () => ({
  getMyCommerce: vi.fn(),
  addCommerceProductBlock: vi.fn(),
  createCommerceProduct: vi.fn(),
  setCommerceProductStatus: vi.fn(),
  setWebinarRegistrationAttendance: vi.fn(),
  updateCommerceProduct: vi.fn(),
}));
vi.mock("@/lib/profile.functions", () => ({ getMyProfile: vi.fn() }));
vi.mock("@/lib/booking.functions", () => ({ getBookingAvailabilityDefaults: vi.fn() }));
vi.mock("@/lib/commerce-growth.functions", () => ({
  deleteCommerceDiscountCode: vi.fn(),
  deleteCommerceOrderBump: vi.fn(),
  saveCommerceDiscountCode: vi.fn(),
  saveCommerceOrderBump: vi.fn(),
}));
vi.mock("@/lib/commerce-delete.functions", () => ({ deleteCommerceProduct: vi.fn() }));
vi.mock("@/lib/store-webmcp", () => ({ createStoreWebMcpTools: vi.fn(() => []) }));
vi.mock("@/lib/webmcp", () => ({ useWebMcpTools: vi.fn() }));

import { Route } from "./store";

const newsletter = {
  id: "55555555-5555-4555-8555-555555555555",
  creator_id: "33333333-3333-4333-8333-333333333333",
  kind: "newsletter" as const,
  status: "published" as const,
  slug: "creator-studio-notes-newsletter",
  public_slug: "studio-notes-paid",
  title: "Studio Notes paid newsletter",
  subtitle: "Paid newsletter",
  description: "Paid Studio Notes.",
  cover_url: null,
  pricing_type: "subscription" as const,
  price_amount: 900,
  currency: "usd",
  billing_interval: "month" as const,
  cta_label: "Subscribe",
  settings: { newsletterPublicationId: "11111111-1111-4111-8111-111111111111" },
  inventory_limit: null,
  sales_count: 0,
  noindex: false,
};

function dashboard() {
  return {
    products: [newsletter],
    orders: [],
    leads: [],
    webinarRegistrations: [],
    audienceContacts: [],
    audienceEvents: [],
    audienceLists: [],
    audienceListMembers: [],
    audienceCampaigns: [],
    discountCodes: [],
    orderBumps: [],
    orderItems: [],
    paymentSessions: [],
    stats: {
      products: 1,
      growth: 0,
      published: 1,
      orders: 0,
      leads: 0,
      audience: 0,
      checkoutStarted: 0,
      checkoutCompleted: 0,
      checkoutFailed: 0,
      checkoutConversion: 0,
      discountedCheckouts: 0,
      bumpCheckouts: 0,
      revenue: 0,
      net: 0,
      fees: 0,
      currency: null,
      moneyByCurrency: [],
    },
    environment: { app: "test", payments: "stripe" },
    locked: false,
    plan: "store",
    storeSetup: { ready: true, selectedProvider: "stripe" },
  };
}

function renderStore() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const StorePage = Route.options.component as ComponentType;
  const result = render(
    <QueryClientProvider client={client}>
      <StorePage />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

describe("Store paid newsletter boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeState.tab = "products";
    routeState.create = undefined;
    routeState.edit = undefined;
    vi.mocked(getMyCommerceCurrency).mockResolvedValue({ currency: "usd" });
    vi.mocked(getMyCommerce).mockResolvedValue(dashboard() as never);
    vi.mocked(getMyProfile).mockResolvedValue({ username: "creator" } as never);
  });

  it("redirects the legacy Store Audience tab to Newsletter Audience", async () => {
    routeState.tab = "audience";
    renderStore();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/email-marketing",
        search: { section: "subscribers" },
        replace: true,
      }),
    );
  });

  it("manages an existing newsletter in Newsletter without generic edit controls", async () => {
    renderStore();

    expect(await screen.findByText(newsletter.title)).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage in Newsletter" })).toHaveAttribute(
      "href",
      "/email-marketing?section=overview&publication=11111111-1111-4111-8111-111111111111",
    );
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("offers Newsletter creation through its canonical publication builder", async () => {
    renderStore();
    await screen.findByText(newsletter.title);
    fireEvent.click(await screen.findByRole("button", { name: "New product" }));

    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Paid newsletter/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Canonical newsletter builder");
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("Store archived products", () => {
  const activeProduct = {
    ...newsletter,
    kind: "coaching_call" as const,
    title: "Google OAuth Review Session",
    sales_count: 4,
  };
  const archivedProduct = { ...activeProduct, status: "archived" as const };

  beforeEach(() => {
    vi.clearAllMocks();
    routeState.tab = "products";
    routeState.create = undefined;
    routeState.edit = undefined;
    vi.mocked(getMyCommerceCurrency).mockResolvedValue({ currency: "usd" });
    vi.mocked(getMyProfile).mockResolvedValue({ username: "creator" } as never);
    vi.mocked(getMyCommerce).mockResolvedValue({
      ...dashboard(),
      products: [archivedProduct],
    } as never);
  });

  it("keeps archived products out of the active list and offers a restorable archive", async () => {
    renderStore();
    const archived = await screen.findByRole("button", { name: /Archived \(1\)/ });
    expect(screen.queryByText(archivedProduct.title)).not.toBeInTheDocument();
    expect(screen.getByText("No active products")).toBeVisible();
    fireEvent.click(archived);
    expect(screen.getByText(archivedProduct.title)).toBeVisible();
    expect(screen.getByRole("button", { name: "Restore" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Active \(0\)/ }));
    expect(screen.queryByText(archivedProduct.title)).not.toBeInTheDocument();
  });

  it("explains archiving before removing a product with orders from the active list", async () => {
    vi.mocked(getMyCommerce).mockResolvedValueOnce({
      ...dashboard(),
      products: [activeProduct],
    } as never);
    vi.mocked(deleteCommerceProduct).mockResolvedValue({
      deleted: false,
      archived: true,
      removedBlocks: 1,
    });
    renderStore();
    fireEvent.click(await screen.findByRole("button", { name: "Remove product" }));
    expect(screen.getByRole("heading", { name: `Archive ${activeProduct.title}?` })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Archive product" }));
    await waitFor(() => expect(screen.queryByText(activeProduct.title)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Archived \(1\)/ })).toBeVisible();
  });

  it("lets a creator open the builder without connecting a gateway for a free offer", async () => {
    vi.mocked(getMyCommerce).mockResolvedValue({
      ...dashboard(),
      storeSetup: { ready: false, selectedProvider: null },
      products: [activeProduct],
    } as never);
    renderStore();
    fireEvent.click(await screen.findByRole("button", { name: "New product" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: /Community/ })).toBeVisible();
  });

  it("allows restoring free offers without a gateway and prevents archived blocks", async () => {
    vi.mocked(getMyCommerce).mockResolvedValue({
      ...dashboard(),
      storeSetup: { ready: false, selectedProvider: null },
      products: [
        { ...archivedProduct, pricing_type: "free", price_amount: 0, billing_interval: null },
      ],
    } as never);
    renderStore();
    fireEvent.click(await screen.findByRole("button", { name: /Archived \(1\)/ }));
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add block" })).toBeDisabled();
  });

  it("starts a new community with the creator's saved currency", async () => {
    routeState.create = "paid_community";
    vi.mocked(getMyCommerceCurrency).mockResolvedValue({ currency: "inr" });
    renderStore();
    await screen.findByRole("textbox", { name: "Title" });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(within(dialog).getByLabelText("Currency")).toHaveValue("inr");
  });

  it("preserves unsaved edits when the product query refreshes", async () => {
    const product = {
      ...activeProduct,
      kind: "paid_community",
      settings: { welcomeMessage: "Welcome" },
    };
    const data = { ...dashboard(), products: [product] };
    routeState.edit = product.id;
    vi.mocked(getMyCommerce).mockResolvedValue(data as never);
    const { client } = renderStore();
    await screen.findByRole("textbox", { name: "Title" });
    const dialog = screen.getByRole("dialog");
    const title = within(dialog).getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Keep this unsaved edit" } });
    await act(async () => {
      client.setQueryData(["my-commerce"], {
        ...data,
        products: [{ ...product, title: "New server title", updated_at: "2026-11-27T00:00:00Z" }],
      });
    });
    await screen.findByText("New server title");
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Keep this unsaved edit");
  });
});

it("lists free draft Newsletter publications in Products without generic publish/delete controls", async () => {
  vi.mocked(getMyCommerce).mockResolvedValue({ ...dashboard(), products: [] } as never);
  vi.mocked(getMyProfile).mockResolvedValue({ username: "creator" } as never);
  vi.mocked(getMyNewsletterPublications).mockResolvedValue([
    {
      id: "free-publication",
      title: "Weekly free notes",
      slug: "weekly",
      logoUrl: null,
      status: "draft",
      isDefault: false,
      subscriberCount: 12,
    },
  ]);
  routeState.tab = "products";
  routeState.create = undefined;
  routeState.edit = undefined;
  renderStore();
  expect(await screen.findByText("Weekly free notes")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete product" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit newsletter" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("free-publication");
});

it("does not create a different publication when a legacy Newsletter product lacks its publication link", async () => {
  vi.mocked(getMyCommerce).mockResolvedValue({
    ...dashboard(),
    products: [{ ...newsletter, settings: {} }],
  } as never);
  vi.mocked(getMyProfile).mockResolvedValue({ username: "creator" } as never);
  routeState.tab = "products";
  routeState.create = undefined;
  routeState.edit = newsletter.id;
  renderStore();
  expect(await screen.findByRole("alert")).toHaveTextContent(/publication link/i);
  expect(screen.queryByText(/Canonical newsletter builder/)).not.toBeInTheDocument();
});
