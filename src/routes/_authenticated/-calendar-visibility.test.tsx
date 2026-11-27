import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { getBookingWorkspace } from "@/lib/booking.functions";
import { createCommerceProduct, updateCommerceProduct } from "@/lib/commerce.functions";
import { getMyCommerceCurrency } from "@/lib/commerce-currency.functions";
import { DEFAULT_AVAILABILITY } from "@/lib/booking";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => ({ tab: "sessions", settings: "general" }),
  }),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    search: _search,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    search?: unknown;
    children: ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => <header>Calendar</header> }));
vi.mock("@/lib/booking.functions", () => ({
  getBookingWorkspace: vi.fn(),
  saveBookingAvailability: vi.fn(),
  setBookingReviewVisibility: vi.fn(),
  setPublicCalendarPage: vi.fn(),
}));
vi.mock("@/lib/commerce.functions", () => ({
  createCommerceProduct: vi.fn(),
  updateCommerceProduct: vi.fn(),
}));
vi.mock("@/lib/commerce-currency.functions", () => ({
  getMyCommerceCurrency: vi.fn().mockResolvedValue({ currency: "usd" }),
}));
import { Route } from "./calendar";
const product = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "coaching_call",
  status: "published",
  title: "Private coaching",
  subtitle: "Focused advice",
  description: "Your private session",
  slug: "coaching",
  public_slug: "coaching",
  cover_url: null,
  pricing_type: "one_time",
  price_amount: 2500,
  currency: "eur",
  billing_interval: null,
  cta_label: "Book",
  inventory_limit: null,
  sales_count: 2,
  noindex: false,
  settings: {
    durationMinutes: 45,
    minimumNoticeMinutes: 120,
    weeklyRules: [{ day: 1, start: "09:00", end: "15:00" }],
  },
};
function workspace(item = product) {
  return {
    locked: false,
    availability: DEFAULT_AVAILABILITY,
    availabilityConfigured: true,
    products: [item],
    bookings: [],
    reviews: [],
    calendarConnections: [{ id: "google", status: "active" }],
    fathomConnections: [],
    readiness: { google: true },
    publicCalendar: { enabled: true, username: "creator" },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBookingWorkspace).mockResolvedValue(workspace() as never);
  vi.mocked(updateCommerceProduct).mockImplementation(async (options) => {
    const { data } = options as unknown as { data: { product: Partial<typeof product> } };
    return { ...product, ...data.product } as never;
  });
});
function renderCalendar() {
  const Page = Route.options.component as ComponentType;
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <Page />
    </QueryClientProvider>,
  );
}
it("saves a published session as unlisted without changing its currency, content, or availability", async () => {
  renderCalendar();
  const listed = await screen.findByRole(
    "switch",
    { name: "List Private coaching publicly" },
    { timeout: 10_000 },
  );
  expect(listed).toBeChecked();
  fireEvent.click(listed);
  await waitFor(() =>
    expect(updateCommerceProduct).toHaveBeenCalledWith({
      data: {
        id: product.id,
        product: expect.objectContaining({
          currency: "eur",
          description: product.description,
          settings: { ...product.settings, calendarVisibility: "unlisted" },
        }),
      },
    }),
  );
  expect(screen.getByText(/direct link/i)).toBeVisible();
});
it("shows existing unlisted sessions in the owner Calendar and lets the owner list them again", async () => {
  vi.mocked(getBookingWorkspace).mockResolvedValue(
    workspace({
      ...product,
      settings: { ...product.settings, calendarVisibility: "unlisted" },
    } as typeof product) as never,
  );
  renderCalendar();
  const listed = await screen.findByRole(
    "switch",
    { name: "List Private coaching publicly" },
    { timeout: 10_000 },
  );
  expect(listed).not.toBeChecked();
  expect(screen.getByText("Unlisted")).toBeVisible();
  fireEvent.click(listed);
  await waitFor(() =>
    expect(updateCommerceProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          product: expect.objectContaining({
            settings: expect.objectContaining({ calendarVisibility: "listed" }),
          }),
        }),
      }),
    ),
  );
});

it("creates an unlisted custom session using the saved default currency", async () => {
  vi.mocked(getBookingWorkspace).mockResolvedValue({ ...workspace(), products: [] } as never);
  vi.mocked(getMyCommerceCurrency).mockResolvedValue({ currency: "inr" });
  vi.mocked(createCommerceProduct).mockResolvedValue({ ...product } as never);
  renderCalendar();
  fireEvent.click(
    await screen.findByRole("button", { name: "Custom session" }, { timeout: 10_000 }),
  );
  fireEvent.change(screen.getByPlaceholderText("Portfolio review"), {
    target: { value: "Private intro" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Session visibility" }), {
    target: { value: "unlisted" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create custom session" }));
  await waitFor(() =>
    expect(createCommerceProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          product: expect.objectContaining({
            title: "Private intro",
            currency: "inr",
            settings: expect.objectContaining({ calendarVisibility: "unlisted" }),
          }),
        }),
      }),
    ),
  );
});
