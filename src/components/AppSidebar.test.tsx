import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAV_GROUPS, AppSidebar } from "./AppSidebar";

const routerState = vi.hoisted(() => ({
  pathname: "/link",
  search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => (
    <a
      href={`${to}${search ? `?${new URLSearchParams(search as Record<string, string>)}` : ""}`}
      {...props}
    >
      {children}
    </a>
  ),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; search: Record<string, unknown> } }) => unknown;
  }) => select({ location: routerState }),
}));
vi.mock("./WorkspaceMenu", () => ({
  WorkspaceMenu: () => <button type="button" aria-label="Open workspace menu" />,
}));

function renderSidebar(collapsed = false, onCollapsedChange = vi.fn()) {
  return render(
    <AppSidebar
      profile={{ display_name: "Yash", username: "yash" }}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    />,
  );
}

describe("AppSidebar", () => {
  afterEach(() => {
    routerState.pathname = "/link";
    routerState.search = {};
    vi.unstubAllGlobals();
  });

  it("groups creator tools in the requested order and pins Earn above the profile", () => {
    expect(
      APP_NAV_GROUPS.map(({ label, items }) => [label, items.map((item) => item.label)]),
    ).toEqual([
      ["Create", ["Agent", "Brain", "Routine", "MCP"]],
      ["Grow", ["Post Scheduler", "Auto DMs", "Social Insights", "Discover"]],
      ["Monetize", ["Link", "Store", "Priority DM", "Calendar", "Community", "Newsletter"]],
    ]);

    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "App navigation" });
    const navigation = within(sidebar).getByRole("navigation", { name: "Creator tools" });
    expect(navigation).toHaveClass("overflow-y-auto", "flex-1");
    expect(
      within(navigation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Create", "Grow", "Monetize"]);
    expect(within(navigation).queryByText("APPS")).not.toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "Earn" })).not.toBeInTheDocument();
    const earn = within(sidebar).getByRole("link", { name: "Earn" });
    const profile = within(sidebar).getByRole("button", { name: "Open workspace menu" });
    expect(earn).toHaveAttribute("href", "/earn");
    expect(earn.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sidebar).queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
  });

  it("opens the current section and toggles other sections independently", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "App navigation" });
    const monetize = within(sidebar).getByRole("button", { name: "Monetize" });
    const create = within(sidebar).getByRole("button", { name: "Create" });
    const grow = within(sidebar).getByRole("button", { name: "Grow" });

    expect(monetize).toHaveAttribute("aria-expanded", "true");
    expect(create).toHaveAttribute("aria-expanded", "false");
    expect(within(sidebar).getByRole("link", { name: "Link" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(create);
    expect(create).toHaveAttribute("aria-expanded", "true");
    expect(monetize).toHaveAttribute("aria-expanded", "true");
    expect(within(sidebar).getByRole("link", { name: "Agent" })).toHaveAttribute(
      "href",
      "/content?tab=agent",
    );
    expect(within(sidebar).getByRole("link", { name: "Brain" })).toHaveAttribute(
      "href",
      "/content?tab=brain",
    );
    expect(within(sidebar).getByRole("link", { name: "Routine" })).toHaveAttribute(
      "href",
      "/content?tab=agent&routines=true",
    );
    expect(within(sidebar).getByRole("link", { name: "MCP" })).toHaveAttribute("href", "/mcp");

    fireEvent.click(grow);
    expect(grow).toHaveAttribute("aria-expanded", "true");
    expect(create).toHaveAttribute("aria-expanded", "true");
    expect(within(sidebar).getByRole("link", { name: "Post Scheduler" })).toHaveAttribute(
      "href",
      "/post-scheduler",
    );
    expect(within(sidebar).getByRole("link", { name: "Auto DMs" })).toHaveAttribute(
      "href",
      "/auto-dms",
    );
    expect(within(sidebar).getByRole("link", { name: "Social Insights" })).toHaveAttribute(
      "href",
      "/social-insights",
    );
    expect(within(sidebar).getByRole("link", { name: "Discover" })).toHaveAttribute(
      "href",
      "/content?tab=discover",
    );
    fireEvent.click(grow);
    expect(grow).toHaveAttribute("aria-expanded", "false");
    expect(create).toHaveAttribute("aria-expanded", "true");
  });

  it("expands on hover and collapses on leave", () => {
    const onCollapsedChange = vi.fn();
    const { rerender } = renderSidebar(true, onCollapsedChange);
    const sidebar = screen.getByRole("complementary", { name: "App navigation" });
    expect(within(sidebar).getByRole("button", { name: "Monetize" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.mouseEnter(sidebar);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);

    rerender(
      <AppSidebar
        profile={{ display_name: "Yash", username: "yash" }}
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
      />,
    );
    fireEvent.mouseLeave(sidebar);
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
  });

  it.each(["/email-marketing", "/email-marketing/newsletters/example"])(
    "marks Newsletter active at %s",
    (pathname) => {
      routerState.pathname = pathname;
      renderSidebar();
      expect(screen.getByRole("link", { name: "Newsletter" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    },
  );

  it("opens Grow and marks Post Scheduler active on its route", () => {
    routerState.pathname = "/post-scheduler";
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "App navigation" });
    expect(within(sidebar).getByRole("button", { name: "Grow" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(sidebar).getByRole("link", { name: "Post Scheduler" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it.each([
    ["Agent", { tab: "agent" }],
    ["Brain", { tab: "brain" }],
    ["Routine", { tab: "agent", routines: true }],
    ["Discover", { tab: "discover" }],
  ])("marks %s active for its Content view", (label, search) => {
    routerState.pathname = "/content";
    routerState.search = search;
    renderSidebar();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  });

  it("opens mobile navigation with Earn pinned outside the scroll area", async () => {
    renderSidebar(true);
    const trigger = screen.getByRole("button", { name: "Open app navigation" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "App navigation" });
    const navigation = within(dialog).getByRole("navigation", { name: "Creator tools" });
    expect(dialog).toHaveClass("h-dvh", "overflow-hidden");
    expect(navigation).toHaveClass("min-h-0", "overflow-y-auto", "overscroll-contain");
    expect(within(navigation).queryByRole("link", { name: "Earn" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Earn" })).toHaveAttribute("href", "/earn");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(within(dialog).getByRole("link", { name: "MCP" })).toHaveAttribute("href", "/mcp");
    fireEvent.click(within(dialog).getByRole("button", { name: "Grow" }));
    expect(within(dialog).getByRole("link", { name: "Post Scheduler" })).toHaveAttribute(
      "href",
      "/post-scheduler",
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "App navigation" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("releases the mobile dialog when the viewport becomes desktop-sized", async () => {
    let onChange: (() => void) | undefined;
    const media = {
      matches: false,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        onChange = listener;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media),
    );
    renderSidebar(true);

    fireEvent.click(screen.getByRole("button", { name: "Open app navigation" }));
    expect(screen.getByRole("dialog", { name: "App navigation" })).toBeInTheDocument();

    media.matches = true;
    onChange?.();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "App navigation" })).not.toBeInTheDocument(),
    );
  });
});
