import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMyCommerce } from "@/lib/commerce.functions";
import { getMyProfile } from "@/lib/profile.functions";

const navigate = vi.hoisted(() => vi.fn());
const routeState = vi.hoisted(() => ({ tab: "products", create: undefined, edit: undefined }));

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
  return render(
    <QueryClientProvider client={client}>
      <StorePage />
    </QueryClientProvider>,
  );
}

describe("Store paid newsletter boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeState.tab = "products";
    vi.mocked(getMyCommerce).mockResolvedValue(dashboard() as never);
    vi.mocked(getMyProfile).mockResolvedValue({ username: "creator" } as never);
  });

  it("redirects the legacy Store Audience tab to Email Marketing Audience", async () => {
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

  it("manages an existing newsletter in Email Marketing without generic edit controls", async () => {
    renderStore();

    expect(await screen.findByText(newsletter.title)).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage in Email Marketing" })).toHaveAttribute(
      "href",
      "/email-marketing?section=overview",
    );
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("does not offer paid newsletters in the generic product picker", async () => {
    renderStore();
    await screen.findByText(newsletter.title);
    fireEvent.click(await screen.findByRole("button", { name: "New product" }));

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Paid newsletter/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Digital product/i })).toBeVisible();
  });
});
