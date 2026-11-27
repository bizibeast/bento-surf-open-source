import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { getMyCommerce, setCommerceProductStatus } from "@/lib/commerce.functions";
import { getCommunityWorkspace } from "@/lib/community.functions";
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => ({ tab: "overview", community: undefined }),
  }),
  useNavigate: () => navigate,
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
vi.mock("@/lib/community.functions", () => ({ getCommunityWorkspace: vi.fn() }));
vi.mock("@/lib/commerce.functions", () => ({
  getMyCommerce: vi.fn(),
  setCommerceProductStatus: vi.fn(),
}));
vi.mock("@/lib/profile.functions", () => ({
  getMyProfile: vi.fn().mockResolvedValue({ username: "creator" }),
}));
vi.mock("@/components/commerce/WorkspaceProductComposer", () => ({
  WorkspaceProductComposer: ({
    kind,
    productId,
    open,
    onSaved,
  }: {
    kind: string;
    productId?: string;
    open: boolean;
    onSaved?: (product: { id: string }) => unknown;
  }) =>
    open ? (
      <div role="dialog">
        Compose {kind} {productId}
        <button type="button" onClick={() => onSaved?.({ id: "created-community" })}>
          Save product
        </button>
      </div>
    ) : null,
}));
import { Route as CommunityRoute } from "./community";
import { Route as CoursesRoute } from "./courses";
const course = {
  id: "course-id",
  kind: "course",
  title: "Launch your craft",
  status: "published",
  price_amount: 1900,
  currency: "usd",
  pricing_type: "one_time",
  billing_interval: null,
  public_slug: "craft",
  settings: { lessons: [{ id: "lesson", title: "Your first step" }] },
  sales_count: 3,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCommunityWorkspace).mockResolvedValue({
    selected: null,
    products: [],
    locked: false,
  } as never);
  vi.mocked(getMyCommerce).mockResolvedValue({
    locked: false,
    products: [
      course,
      { ...course, id: "community-id", kind: "paid_community", title: "My private club" },
    ],
    storeSetup: { selectedProvider: "stripe" },
  } as never);
  vi.mocked(setCommerceProductStatus).mockResolvedValue({ ...course, status: "archived" } as never);
});
function renderRoute(route: unknown) {
  const Page = (route as { component: ComponentType }).component;
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Page />
    </QueryClientProvider>,
  );
}
it("opens the shared creator from Community without a Products detour", async () => {
  renderRoute(CommunityRoute);
  fireEvent.click(await screen.findByRole("button", { name: "Create community" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Compose paid_community");
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "Create community" })).not.toBeInTheDocument();
});
it("selects the saved community returned by the shared composer", async () => {
  renderRoute(CommunityRoute);
  fireEvent.click(await screen.findByRole("button", { name: "Create community" }));
  fireEvent.click(screen.getByRole("button", { name: "Save product" }));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith({
      to: "/community",
      search: { tab: "overview", community: "created-community" },
    }),
  );
});
it("lists only courses and opens their existing lesson editor in place", async () => {
  renderRoute(CoursesRoute);
  expect(await screen.findByText(course.title)).toBeVisible();
  expect(screen.queryByText("My private club")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Manage lessons" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Compose course course-id");
  expect(navigate).not.toHaveBeenCalled();
});
it("creates a course and archives existing courses in the course workspace", async () => {
  renderRoute(CoursesRoute);
  await screen.findByText(course.title);
  fireEvent.click(screen.getByRole("button", { name: "New course" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Compose course");
  fireEvent.click(screen.getByRole("button", { name: "Archive course" }));
  await waitFor(() =>
    expect(setCommerceProductStatus).toHaveBeenCalledWith({
      data: { id: course.id, status: "archived" },
    }),
  );
});
