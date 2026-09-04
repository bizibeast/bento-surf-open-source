import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAV_ITEMS, AppSidebar } from "./AppSidebar";

const routerState = vi.hoisted(() => ({ pathname: "/link" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: routerState.pathname } }),
}));

describe("AppSidebar", () => {
  afterEach(() => {
    routerState.pathname = "/link";
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shows the canonical source link by default", () => {
    render(
      <AppSidebar
        profile={{ display_name: "Creator", username: "creator" }}
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://github.com/bizibeast/bento-surf-open-source",
    );
  });

  it("shows the configured source link", () => {
    vi.stubEnv("VITE_SOURCE_URL", "https://code.example/bento-surf");
    render(
      <AppSidebar
        profile={{ display_name: "Creator", username: "creator" }}
        collapsed={false}
        onCollapsedChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://code.example/bento-surf",
    );
  });
  it("expands on hover, collapses on leave, and hides settings when closed", () => {
    const onCollapsedChange = vi.fn();
    const { rerender } = render(
      <AppSidebar
        profile={{ display_name: "Ada", username: "ada" }}
        collapsed
        onCollapsedChange={onCollapsedChange}
      />,
    );

    const labels = [
      "Home",
      "Link",
      "Store",
      "Priority DM",
      "Calendar",
      "Community",
      "Email Marketing",
      "Post Scheduler",
      "Social Insights",
      "Auto DMs",
      "MCP",
      "Earn",
    ];
    expect(APP_NAV_ITEMS.map((item) => item.label)).toEqual(labels);
    expect(APP_NAV_ITEMS.map((item) => item.to)).toEqual([
      "/home",
      "/link",
      "/store",
      "/priority-dm",
      "/calendar",
      "/community",
      "/email-marketing",
      "/post-scheduler",
      "/social-insights",
      "/auto-dms",
      "/mcp",
      "/earn",
    ]);
    for (const label of labels) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    const activeLink = screen.getByRole("link", { name: "Link" });
    expect(activeLink).toHaveAttribute("aria-current", "page");
    expect(activeLink).toHaveClass(
      "min-h-9",
      "rounded-[8px]",
      "border",
      "bg-card",
      "shadow-sm",
      "text-xs",
      "text-foreground",
    );
    expect(activeLink).not.toHaveClass(
      "rounded-lg",
      "rounded-2xl",
      "bg-foreground",
      "shadow-[0_3px_0_rgba(23,33,58,0.12),0_7px_16px_-10px_rgba(23,33,58,0.45)]",
    );
    const inactiveLink = screen.getByRole("link", { name: "Home" });
    expect(inactiveLink).toHaveClass("hover:bg-black/[0.035]");
    expect(inactiveLink).not.toHaveClass("hover:border-border/70", "hover:shadow-sm");
    expect(activeLink.parentElement).toHaveClass("border-t", "pt-2.5");
    expect(screen.getByRole("link", { name: "Post Scheduler" }).parentElement).toHaveClass(
      "border-t",
      "pt-2.5",
    );
    expect(screen.getByRole("link", { name: "MCP" })).toHaveAttribute("href", "/mcp");
    expect(screen.getByRole("link", { name: "Priority DM" })).toHaveAttribute(
      "href",
      "/priority-dm",
    );
    expect(APP_NAV_ITEMS.findIndex((item) => item.label === "Email Marketing")).toBe(
      APP_NAV_ITEMS.findIndex((item) => item.label === "Community") + 1,
    );
    expect(APP_NAV_ITEMS.findIndex((item) => item.label === "Priority DM")).toBe(
      APP_NAV_ITEMS.findIndex((item) => item.label === "Store") + 1,
    );
    expect(screen.getByRole("link", { name: "MCP" }).parentElement).toHaveClass(
      "border-t",
      "pt-2.5",
    );
    expect(screen.getByRole("link", { name: "Community" }).parentElement).not.toHaveClass(
      "border-t",
    );
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(document.querySelector('img[src="/branding/bento-logo.svg"]')).not.toBeNull();

    const sidebar = screen.getByLabelText("App navigation");
    fireEvent.mouseEnter(sidebar);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);

    rerender(
      <AppSidebar
        profile={{ display_name: "Ada", username: "ada" }}
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
      />,
    );
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    fireEvent.mouseLeave(screen.getByLabelText("App navigation"));
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
  });

  it.each(["/email-marketing", "/email-marketing/newsletters/example"])(
    "marks Email Marketing active at %s",
    (pathname) => {
      routerState.pathname = pathname;
      render(
        <AppSidebar
          profile={{ display_name: "Ada", username: "ada" }}
          collapsed={false}
          onCollapsedChange={vi.fn()}
        />,
      );

      expect(screen.getByRole("link", { name: "Email Marketing" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    },
  );

  it("opens a scrollable modal navigation that closes on Escape", async () => {
    render(
      <AppSidebar
        profile={{ display_name: "Ada", username: "ada" }}
        collapsed
        onCollapsedChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open app navigation" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "App navigation" });
    const navigation = within(dialog).getByRole("navigation", { name: "Creator tools" });
    expect(dialog).toHaveClass("h-dvh", "overflow-hidden");
    expect(navigation).toHaveClass("min-h-0", "overflow-y-auto", "overscroll-contain");
    expect(within(dialog).getByRole("link", { name: "MCP" })).toHaveAttribute("href", "/mcp");
    expect(within(dialog).getByRole("link", { name: "Earn" })).toHaveAttribute("href", "/earn");

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
    render(
      <AppSidebar
        profile={{ display_name: "Ada", username: "ada" }}
        collapsed
        onCollapsedChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open app navigation" }));
    expect(screen.getByRole("dialog", { name: "App navigation" })).toBeInTheDocument();

    media.matches = true;
    onChange?.();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "App navigation" })).not.toBeInTheDocument(),
    );
  });
});
