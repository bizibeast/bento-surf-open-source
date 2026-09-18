import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutItem } from "react-grid-layout/legacy";
import { getMyBlocks, createBlock, updateBlockLayout } from "@/lib/blocks.functions";
import { getMySystemPageCanvas, saveMySystemPageLayout } from "@/lib/page-system-layout.functions";

vi.mock("@/lib/profile.functions", () => ({ getMyProfile: vi.fn(), updateProfile: vi.fn() }));
vi.mock("@/lib/newsletter.functions", () => ({
  getMyNewsletter: vi.fn(),
  saveNewsletterPublication: vi.fn(),
}));
vi.mock("@/lib/blocks.functions", () => ({
  getMyBlocks: vi.fn(),
  getMySetupBlocks: vi.fn(),
  createBlock: vi.fn(),
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  updateBlockLayout: vi.fn(),
}));
vi.mock("@/lib/pages.functions", () => ({
  getMyPages: vi.fn(),
  createPage: vi.fn(),
  renamePage: vi.fn(),
  deletePage: vi.fn(),
  reorderMyPages: vi.fn(),
}));
vi.mock("@/lib/page-system-layout.functions", () => ({
  getMySystemPageCanvas: vi.fn(),
  saveMySystemPageLayout: vi.fn(),
}));
vi.mock("@/lib/booking.functions", () => ({ setPublicCalendarPage: vi.fn() }));
vi.mock("@/lib/social-analytics.functions", () => ({ setPublicSocialInsights: vi.fn() }));
vi.mock("@/lib/map.functions", () => ({ geocodeMapLocation: vi.fn() }));
vi.mock("@/lib/upload", () => ({ uploadFile: vi.fn() }));
vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
vi.mock("@/lib/webmcp", () => ({ useWebMcpTools: vi.fn() }));
vi.mock("@/components/UpgradeDialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/settings/AnalyticsSettingsPanel", () => ({
  AnalyticsSettingsPanel: () => null,
}));
vi.mock("../login", () => ({ Field: () => null }));
// jsdom has no pointer geometry. Exercise the route's real drag/resize callbacks at the grid boundary.
const grid = vi.hoisted(() => ({ props: {} as Record<string, any>, real: false }));
vi.mock("react-grid-layout/legacy", async (importOriginal) => {
  const { default: ActualGrid } = await importOriginal<typeof import("react-grid-layout/legacy")>();
  return {
    default: (props: { children: ReactNode }) => {
      grid.props = props;
      return grid.real ? (
        <ActualGrid {...(props as ComponentProps<typeof ActualGrid>)} />
      ) : (
        <div>{props.children}</div>
      );
    },
  };
});

import { getMyProfile } from "@/lib/profile.functions";
import { getMyNewsletter } from "@/lib/newsletter.functions";
import { getMyPages } from "@/lib/pages.functions";
import { getMySetupBlocks } from "@/lib/blocks.functions";
import { Route } from "./link";

const pageId = "11111111-1111-4111-8111-111111111111";
const customId = "22222222-2222-4222-8222-222222222222";
const blockId = "33333333-3333-4333-8333-333333333333";
const profileId = "44444444-4444-4444-8444-444444444444";
const systems = [
  ["calendar", "Manage Calendar", "/calendar"],
  ["store", "Manage Store", "/store"],
  ["insights", "Manage Insights", "/social-insights"],
  ["newsletter", "Manage Newsletters", "/email-marketing"],
] as const;

function page(system: (typeof systems)[number][0] | null = "calendar", overrides = {}) {
  return {
    id: system ? pageId : customId,
    name: system ? `${system} canvas` : "About",
    slug: system ?? "about",
    system,
    url: null,
    is_visible: true,
    user_id: profileId,
    position: 0,
    created_at: "2026-09-05",
    updated_at: "2026-09-05",
    ...overrides,
  };
}
function canvas(system: (typeof systems)[number][0] = "calendar") {
  return {
    page: { ...page(system), system },
    items: [
      {
        key: "intro",
        pageId,
        system,
        kind: "intro" as const,
        title: `${system} introduction`,
        data: { username: "creator", displayName: "Creator", description: "Welcome" },
        defaultW: 4,
        defaultH: 2,
      },
    ],
    layout: [{ itemKey: "intro", x: 0, y: 0, w: 4, h: 2, position: 0 }],
  };
}
const block = {
  id: blockId,
  page_id: pageId,
  user_id: profileId,
  type: "note",
  content: { text: "Editable note" },
  x: 4,
  y: 0,
  w: 2,
  h: 2,
  position: 0,
  cover_url: null,
  created_at: "2026-09-05",
  updated_at: "2026-09-05",
};

async function renderEditor(entries = [`/link?page=${pageId}`], initialIndex = entries.length - 1) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const root = createRootRoute();
  const auth = createRoute({ getParentRoute: () => root, id: "_authenticated" });
  const route = Route.update({ getParentRoute: () => auth, path: "/link" } as never);
  const manager = createRoute({
    getParentRoute: () => auth,
    path: "/calendar",
    component: () => <h1>Calendar manager</h1>,
  });
  const history = createMemoryHistory({ initialEntries: entries, initialIndex });
  const router = createRouter({
    routeTree: root.addChildren([auth.addChildren([route, manager])]),
    history,
    context: { queryClient: client },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Add block" });
  return { router, history, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  grid.real = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.mocked(getMyProfile).mockResolvedValue({
    id: profileId,
    username: "creator",
    display_name: "Creator",
    bio: "Bio",
    onboarded: true,
    header_mode: "with_photo",
    plan_id: "creator",
  } as never);
  vi.mocked(getMyNewsletter).mockResolvedValue({ publication: null } as never);
  vi.mocked(getMySetupBlocks).mockResolvedValue([]);
  vi.mocked(getMyPages).mockResolvedValue([page()] as never);
  vi.mocked(getMyBlocks).mockResolvedValue([block] as never);
  vi.mocked(getMySystemPageCanvas).mockResolvedValue(canvas());
  vi.mocked(saveMySystemPageLayout).mockResolvedValue({ ok: true } as never);
  vi.mocked(updateBlockLayout).mockResolvedValue({ ok: true } as never);
  vi.mocked(createBlock).mockResolvedValue(block as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Link internal page canvases", () => {
  it("switches the desktop layout from the available Link workspace width", async () => {
    await renderEditor();

    expect(document.querySelector(".link-editor-shell")).toBeInTheDocument();
    expect(document.querySelector(".link-editor-layout")).toBeInTheDocument();
    expect(document.querySelector("main")).toHaveClass("link-editor-canvas", "min-w-0");
  });

  it("keeps editable identity and page navigation when the avatar is hidden", async () => {
    const profile = await getMyProfile();
    vi.mocked(getMyProfile).mockResolvedValue({ ...profile, header_mode: "no_banner" } as never);
    await renderEditor();
    expect(screen.getByRole("heading", { name: "Creator" })).toBeVisible();
    expect(screen.getByText("Bio")).toBeVisible();
    expect(screen.getByRole("button", { name: "Home page" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Change avatar" })).toBeNull();
  });

  it("packs the combined desktop reading order despite independently stored system positions", async () => {
    const data: Awaited<ReturnType<typeof getMySystemPageCanvas>> = canvas();
    data.items.push({
      ...data.items[0],
      key: "session:second",
      kind: "session",
      title: "Second session",
    });
    data.layout.push({ itemKey: "session:second", x: 4, y: 2, w: 4, h: 2, position: 1 });
    const secondBlockId = "55555555-5555-4555-8555-555555555555";
    vi.mocked(getMySystemPageCanvas).mockResolvedValue(data);
    vi.mocked(getMyBlocks).mockResolvedValue([
      { ...block, w: 4, position: 1 },
      { ...block, id: secondBlockId, x: 0, y: 2, w: 4, position: 2 },
    ] as never);
    await renderEditor();
    await waitFor(() => expect(grid.props.layout).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Phone view" }));
    expect(grid.props.layout).toEqual([
      expect.objectContaining({ i: "system:intro", x: 0, y: 0, w: 4, h: 2 }),
      expect.objectContaining({ i: blockId, x: 0, y: 2, w: 4, h: 2 }),
      expect.objectContaining({ i: secondBlockId, x: 0, y: 4, w: 4, h: 2 }),
      expect.objectContaining({ i: "system:session:second", x: 0, y: 6, w: 4, h: 2 }),
    ]);
  });

  it.each(["/link", "/calendar"] as const)(
    "protects the newest queued layout across %s leave/return until that page's final save settles",
    async (destination) => {
      let finishFirst!: (value: never) => void;
      let finishSecond!: (value: never) => void;
      vi.mocked(saveMySystemPageLayout)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSecond = resolve;
            }),
        );
      const { client, router } = await renderEditor();
      await waitFor(() => expect(grid.props.layout).toHaveLength(2));
      const dragTo = (x: number) => {
        const start = grid.props.layout.map((item: LayoutItem) => ({ ...item }));
        const moved = { ...start.find((item: LayoutItem) => item.i === "system:intro"), x };
        act(() => {
          grid.props.onDragStart(start, null, moved);
          grid.props.onDragStop(start, null, moved);
        });
      };
      dragTo(2);
      await waitFor(() => expect(saveMySystemPageLayout).toHaveBeenCalledOnce());
      dragTo(1);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
      const olderServerCanvas = canvas();
      olderServerCanvas.layout[0].x = 2;
      vi.mocked(getMySystemPageCanvas).mockResolvedValue(olderServerCanvas);
      vi.mocked(getMyBlocks).mockResolvedValue([{ ...block, y: 2, position: 1 }] as never);
      await act(async () => {
        finishFirst({ ok: true } as never);
      });
      await waitFor(() => expect(saveMySystemPageLayout).toHaveBeenCalledTimes(2));
      const readsBeforeReturn = vi.mocked(getMySystemPageCanvas).mock.calls.length;
      await act(async () => {
        await router.navigate({ to: destination, search: {} });
      });
      await act(async () => {
        await router.navigate({ to: "/link", search: { page: pageId } });
      });
      await waitFor(() =>
        expect(grid.props.layout.find((item: LayoutItem) => item.i === "system:intro")?.x).toBe(1),
      );
      expect(client.getQueryState(["my-blocks", pageId])?.isInvalidated).toBe(false);
      expect(client.getQueryState(["my-system-page", pageId])?.isInvalidated).toBe(false);
      await act(async () => {
        await client.refetchQueries({ queryKey: ["my-system-page", pageId], exact: true });
      });
      expect(getMySystemPageCanvas).toHaveBeenCalledTimes(readsBeforeReturn);
      expect(grid.props.layout.find((item: LayoutItem) => item.i === "system:intro").x).toBe(1);
      await act(async () => {
        finishSecond({ ok: true } as never);
      });
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(client.getQueryState(["my-blocks", pageId])?.isInvalidated).toBe(true);
      expect(client.getQueryState(["my-system-page", pageId])?.isInvalidated).toBe(true);
    },
  );

  it("cancels older in-flight block and canvas reads before applying an optimistic drag", async () => {
    const { client } = await renderEditor();
    await waitFor(() => expect(grid.props.layout).toHaveLength(2));
    let finishRead!: (value: ReturnType<typeof canvas>) => void;
    let finishBlocks!: (value: never) => void;
    vi.mocked(getMySystemPageCanvas).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    vi.mocked(getMyBlocks).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBlocks = resolve;
        }),
    );
    let refetch!: Promise<void>;
    let blockRefetch!: Promise<void>;
    act(() => {
      refetch = client.refetchQueries({ queryKey: ["my-system-page", pageId], exact: true });
    });
    act(() => {
      blockRefetch = client.refetchQueries({ queryKey: ["my-blocks", pageId], exact: true });
    });
    const start = grid.props.layout.map((item: LayoutItem) => ({ ...item }));
    const moved = { ...start.find((item: LayoutItem) => item.i === "system:intro"), x: 2 };
    act(() => {
      grid.props.onDragStart(start, null, moved);
      grid.props.onDragStop(start, null, moved);
    });
    await act(async () => {
      finishRead(canvas());
      finishBlocks([block] as never);
      await Promise.all([refetch, blockRefetch]);
    });
    expect(grid.props.layout.find((item: LayoutItem) => item.i === "system:intro").x).toBe(2);
    expect(grid.props.layout.find((item: LayoutItem) => item.i === blockId).y).toBe(2);
  });

  it("opens the single page management action and flushes its pending layout", async () => {
    const { router } = await renderEditor();
    const intro = await screen.findByRole("article", { name: "calendar introduction" });
    fireEvent.click(
      within(intro.closest("[data-system-item-key]") as HTMLElement).getByRole("button", {
        name: "4×4",
      }),
    );
    expect(within(intro).queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Manage Calendar" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/calendar"));
    expect(saveMySystemPageLayout).toHaveBeenCalledWith({
      data: { pageId, items: [{ itemKey: "intro", x: 0, y: 0, w: 4, h: 4, position: 0 }] },
    });
  });

  it("packs and resizes system tiles on Phone without overwriting the desktop layout", async () => {
    await renderEditor();
    await screen.findByRole("article", { name: "calendar introduction" });
    fireEvent.click(screen.getByRole("button", { name: "Phone view" }));
    await waitFor(() => expect(grid.props.cols).toBe(4));
    expect(grid.props.layout).toEqual([
      expect.objectContaining({ i: "system:intro", x: 0, y: 0, w: 4, h: 2 }),
      expect.objectContaining({ i: blockId, x: 0, y: 2, w: 2, h: 2 }),
    ]);
    const intro = screen
      .getByRole("article", { name: "calendar introduction" })
      .closest("[data-system-item-key]") as HTMLElement;
    fireEvent.click(within(intro).getByRole("button", { name: "4×4" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(saveMySystemPageLayout).not.toHaveBeenCalled();
    expect(updateBlockLayout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Laptop view" }));
    expect(grid.props.layout).toContainEqual(
      expect.objectContaining({ i: "system:intro", x: 0, y: 0, w: 4, h: 2 }),
    );
  });

  it("retains an outgoing drag when the incoming real grid reports its initial layout", async () => {
    grid.real = true;
    const { router } = await renderEditor();
    await screen.findByRole("article", { name: "calendar introduction" });
    const start = grid.props.layout.map((item: LayoutItem) => ({ ...item }));
    const moved = { ...start.find((item: LayoutItem) => item.i === "system:intro"), x: 2 };
    act(() => {
      grid.props.onDragStart(start, null, moved);
      grid.props.onDragStop(start, null, moved);
    });
    await act(async () => {
      await router.navigate({ to: "/link", search: {} });
    });
    await waitFor(() =>
      expect(saveMySystemPageLayout).toHaveBeenCalledWith({
        data: { pageId, items: [{ itemKey: "intro", x: 2, y: 0, w: 4, h: 2, position: 0 }] },
      }),
    );
  });

  it("adds ordinary content below both system tiles and blocks on the selected page", async () => {
    const data = canvas();
    data.layout[0].h = 4;
    vi.mocked(getMySystemPageCanvas).mockResolvedValue(data);
    await renderEditor();
    await waitFor(() => expect(grid.props.layout).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Heading / Text" }));
    await waitFor(() =>
      expect(createBlock).toHaveBeenCalledWith({
        data: { type: "heading", content: { text: "" }, w: 2, h: 2, x: 0, y: 4, pageId },
      }),
    );
  });

  it("resizes introduction tiles with the existing presets without delete or block-edit controls", async () => {
    await renderEditor();
    const intro = await screen.findByRole("article", { name: "calendar introduction" });
    const wrapper = intro.closest("[data-system-item-key]") as HTMLElement;
    expect(within(wrapper).queryByRole("button", { name: "Delete block" })).toBeNull();
    expect(within(wrapper).queryByRole("button", { name: "Edit block" })).toBeNull();
    fireEvent.click(within(wrapper).getByRole("button", { name: "4×4" }));
    await waitFor(() =>
      expect(saveMySystemPageLayout).toHaveBeenCalledWith({
        data: { pageId, items: [{ itemKey: "intro", x: 0, y: 0, w: 4, h: 4, position: 0 }] },
      }),
    );
  });

  it("keeps a newer drag visible when an older layout save completes", async () => {
    let finishSave!: (value: never) => void;
    vi.mocked(saveMySystemPageLayout).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const { client } = await renderEditor();
    await waitFor(() => expect(grid.props.layout).toHaveLength(2));
    const dragTo = (x: number) => {
      const start = grid.props.layout.map((item: LayoutItem) => ({ ...item }));
      const moved = { ...start.find((item: LayoutItem) => item.i === "system:intro"), x };
      act(() => {
        grid.props.onDragStart(start, null, moved);
        grid.props.onDragStop(start, null, moved);
      });
    };
    dragTo(2);
    await waitFor(() => expect(saveMySystemPageLayout).toHaveBeenCalledOnce());
    dragTo(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(saveMySystemPageLayout).toHaveBeenCalledOnce();
    await act(async () => {
      finishSave({ ok: true } as never);
    });
    await waitFor(() => expect(saveMySystemPageLayout).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(grid.props.layout.find((item: LayoutItem) => item.i === "system:intro").x).toBe(1);
  });

  it.each(systems)("opens %s as an editable internal surface", async (system, label, href) => {
    vi.mocked(getMyPages).mockResolvedValue([page(system)] as never);
    vi.mocked(getMySystemPageCanvas).mockResolvedValue(canvas(system));
    await renderEditor();
    const main = await screen.findByRole("main");
    expect(main).toHaveTextContent(`${system} canvas`);
    expect(within(main).getByRole("link", { name: label })).toHaveAttribute("href", href);
    expect(main).toHaveTextContent(`${system} introduction`);
    expect(main).toHaveTextContent("Editable note");
    expect(screen.queryByTitle(/opens visitor page/i)).toBeNull();
    expect(getMyBlocks).toHaveBeenCalledWith({ data: { pageId } });
    expect(getMySystemPageCanvas).toHaveBeenCalledWith({ data: { pageId } });
    expect(within(main).getAllByRole("button", { name: "Delete block" })).toHaveLength(1);
  });

  it("partitions dragged system tiles and block UUIDs, retaining the page during debounce", async () => {
    const { router } = await renderEditor();
    await waitFor(() => expect(grid.props.layout).toHaveLength(2));
    const start = grid.props.layout.map((item: LayoutItem) => ({ ...item }));
    const moved = { ...start.find((item: LayoutItem) => item.i === "system:intro"), x: 2 };
    act(() => {
      grid.props.onDragStart(start, null, moved);
      grid.props.onDragStop(start, null, moved);
    });
    await act(async () => {
      await router.navigate({ to: "/link", search: {} });
    });
    await waitFor(() => expect(saveMySystemPageLayout).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveMySystemPageLayout).toHaveBeenCalledWith({
      data: { pageId, items: [{ itemKey: "intro", x: 2, y: 0, w: 4, h: 2, position: 0 }] },
    });
    expect(updateBlockLayout).toHaveBeenCalledWith({
      data: { items: [{ id: blockId, x: 4, y: 2, w: 2, h: 2, position: 1 }] },
    });
  });

  it("restores custom/system selection on Back and Forward and omits Home's query", async () => {
    vi.mocked(getMyPages).mockResolvedValue([page(), page(null)] as never);
    const { history, router } = await renderEditor([
      "/link",
      `/link?page=${customId}`,
      `/link?page=${pageId}`,
    ]);
    expect(await screen.findByRole("heading", { name: "calendar canvas" })).toBeVisible();
    act(() => history.back());
    expect(await screen.findByRole("heading", { name: "About" })).toBeVisible();
    act(() => history.forward());
    expect(await screen.findByRole("heading", { name: "calendar canvas" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Home page" }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("page"));
    expect(screen.getByRole("heading", { name: "Home" })).toBeVisible();
  });

  it.each(["not-a-uuid", customId, pageId])(
    "falls back from invalid, foreign, or hidden page %s",
    async (selected) => {
      vi.mocked(getMyPages).mockResolvedValue([page("calendar", { is_visible: false })] as never);
      const { router } = await renderEditor([`/link?page=${selected}`]);
      expect(await screen.findByRole("heading", { name: "Home" })).toBeVisible();
      await waitFor(() => expect(router.state.location.search).not.toHaveProperty("page"));
      expect(getMySystemPageCanvas).not.toHaveBeenCalled();
      expect(getMyBlocks).not.toHaveBeenCalledWith({ data: { pageId: selected } });
    },
  );
});
