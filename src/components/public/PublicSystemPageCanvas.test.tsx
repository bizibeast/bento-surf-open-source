import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicSystemPageCanvas } from "./PublicSystemPageCanvas";
import { Route as CalendarRoute } from "@/routes/$username_.calendar";
import { Route as StoreRoute } from "@/routes/$username_.store";
import { PublicProfileView } from "@/routes/$username";
import { PublicNewsletterDirectoryContent } from "@/components/email-marketing/PublicNewsletterArchive";
import type { SystemPageItem } from "@/lib/page-system-layout";

const PublicBookingCalendar = CalendarRoute.options.component!;
const PublicStorePage = StoreRoute.options.component!;

const state = vi.hoisted(() => ({ data: {} as any }));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useSuspenseQuery: () => ({ data: state.data }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: object) => ({
    options,
    useLoaderData: () => state.data,
    useParams: () => ({ username: "@bizibeast" }),
  }),
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ trackPublicEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/components/patterns/PatternBackdrop", () => ({ PatternBackdrop: () => null }));

const pages = ["About", "Calendar", "Store", "Insights", "Newsletters"].map((name, index) => ({
  id: `11111111-1111-4111-8111-11111111111${index}`,
  name,
  slug: name.toLowerCase(),
  href: `/@bizibeast/${name.toLowerCase()}`,
  url: null,
  system: index ? (name === "Newsletters" ? "newsletter" : name.toLowerCase()) : null,
}));
const profile = {
  id: "owner",
  username: "bizibeast",
  display_name: "Bizibeast",
  displayName: "Bizibeast",
  bio: "Helping you make money online",
  theme: "dark",
  pattern: "none",
  header_mode: "no_banner",
  plan_id: "pro",
};
const chrome = { creator: profile, pages, customDomain: null };
const product = (id: string): SystemPageItem => ({
  key: `product:${id}`,
  pageId: pages[2].id,
  system: "store",
  kind: "product",
  title: `Product ${id}`,
  data: { public_slug: `product-${id}`, pricing_type: "free" },
  defaultW: 2,
  defaultH: 2,
});
const account = (): SystemPageItem => ({
  key: "account:social",
  pageId: pages[3].id,
  system: "insights",
  kind: "account",
  title: "Studio",
  data: { provider: "youtube", handle: "studio", followers: 1_200 },
  defaultW: 2,
  defaultH: 2,
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(680);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("includes public product links in server-rendered HTML before grid measurement", () => {
  const html = renderToStaticMarkup(
    <PublicSystemPageCanvas username="bizibeast" blocks={[]} systemItems={[product("a")]} />,
  );
  expect(html).toContain('href="/@bizibeast/products/product-a"');
  expect(html).toContain("Product a");
});

it("preserves saved desktop coordinates and places a new product deterministically without edit controls", () => {
  render(
    <PublicSystemPageCanvas
      username="bizibeast"
      blocks={[]}
      systemItems={[product("a"), product("b")]}
      systemLayout={[{ itemKey: "product:a", x: 4, y: 2, w: 2, h: 2, position: 0 }]}
    />,
  );
  expect(screen.getByRole("article", { name: "Product a" }).parentElement).toHaveStyle({
    left: "346px",
    top: "179px",
    width: "155px",
    height: "155px",
  });
  expect(screen.getByRole("article", { name: "Product b" }).parentElement).toHaveStyle({
    left: "12px",
    top: "12px",
  });
  expect(screen.getByRole("link", { name: /Product a/ })).toHaveAttribute(
    "href",
    "/@bizibeast/products/product-a",
  );
  expect(screen.queryByText(/Edit products|Manage/)).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

it("places new system tiles around existing ordinary blocks on desktop", () => {
  render(
    <PublicSystemPageCanvas
      username="bizibeast"
      systemItems={[product("a")]}
      blocks={[
        {
          id: "note",
          type: "note",
          content: { text: "Existing block" },
          x: 0,
          y: 0,
          w: 2,
          h: 2,
          position: 0,
        },
      ]}
    />,
  );

  expect(screen.getByText("Existing block").closest("[data-bento-public-grid-item]")).toHaveStyle({
    left: "12px",
    top: "12px",
  });
  expect(screen.getByRole("article", { name: "Product a" }).parentElement).toHaveStyle({
    left: "179px",
    top: "12px",
  });
});

it("omits unfinished public blocks and repacks the remaining canvas", () => {
  render(
    <PublicSystemPageCanvas
      blocks={[
        {
          id: "empty-image",
          type: "image",
          content: {},
          x: 0,
          y: 0,
          w: 2,
          h: 2,
          position: 0,
        },
        {
          id: "note",
          type: "note",
          content: { text: "Published note" },
          x: 2,
          y: 0,
          w: 2,
          h: 2,
          position: 1,
        },
      ]}
    />,
  );

  expect(screen.queryByText("Upload an image")).toBeNull();
  expect(screen.getByText("Published note").closest("[data-bento-public-grid-item]")).toHaveStyle({
    left: "12px",
    top: "12px",
  });
});

it("packs the same combined canvas for mobile while retaining ordinary blocks", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(380);
  render(
    <PublicSystemPageCanvas
      username="bizibeast"
      systemItems={[product("a")]}
      systemLayout={[{ itemKey: "product:a", x: 4, y: 4, w: 4, h: 2, position: 0 }]}
      blocks={[
        {
          id: "note",
          type: "note",
          content: { text: "A real note" },
          x: 0,
          y: 0,
          w: 2,
          h: 2,
          position: 0,
        },
      ]}
    />,
  );
  expect(screen.getByText("A real note")).toBeVisible();
  expect(screen.getByRole("article", { name: "Product a" }).parentElement).toHaveStyle({
    left: "12px",
    top: "196px",
    width: "356px",
  });
});

it("compacts legacy public insight account cards to their available metrics", () => {
  render(
    <PublicSystemPageCanvas
      systemItems={[account()]}
      systemLayout={[{ itemKey: "account:social", x: 0, y: 0, w: 4, h: 3, position: 0 }]}
      blocks={[]}
    />,
  );

  expect(screen.getByRole("article", { name: "Studio" }).parentElement).toHaveStyle({
    height: "155px",
  });
});

it.each(["calendar", "store", "insights", "newsletter"])(
  "keeps creator identity and full ordered navigation on the %s route",
  (system) => {
    const page = pages.find((candidate) => candidate.system === system)!;
    state.data = {
      chrome,
      profile,
      pages,
      page,
      blocks: [],
      systemItems: [],
      systemLayout: [],
      activePageId: page.id,
      customDomain: null,
      sessions: [],
      reviews: [],
      products: [],
      creator: profile,
      publications: [],
      socialInsights: { summary: {}, accounts: [], displayPeriodDays: 30 },
    };
    render(
      system === "calendar" ? (
        <PublicBookingCalendar />
      ) : system === "store" ? (
        <PublicStorePage />
      ) : system === "insights" ? (
        <PublicProfileView data={state.data} username="bizibeast" activeSlug="insights" />
      ) : (
        <PublicNewsletterDirectoryContent data={state.data} />
      ),
    );
    expect(document.querySelector("aside > p")).toHaveTextContent("Bizibeast");
    expect(screen.getByRole("navigation", { name: "Creator pages" })).toBeVisible();
    expect(screen.getAllByText("Helping you make money online")[0]).toBeVisible();
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute(
      "href",
      "/@bizibeast/about",
    );
    expect(screen.getByRole("link", { name: "Newsletters" })).toHaveAttribute(
      "href",
      "/@bizibeast/newsletters",
    );
    expect(screen.getByRole("link", { name: page.name })).toHaveAttribute("aria-current", "page");
  },
);
