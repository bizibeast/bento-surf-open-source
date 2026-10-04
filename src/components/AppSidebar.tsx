import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Brain,
  CalendarClock,
  CalendarDays,
  Clock3,
  Compass,
  House,
  BadgeDollarSign,
  Bot,
  Link2,
  Mail,
  Menu,
  MessageCircleMore,
  MessagesSquare,
  Store,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { BentoIcon } from "@/components/BentoBrand";
import { WorkspaceMenu } from "@/components/WorkspaceMenu";
import type { WorkspaceSession } from "@/lib/workspace-session.server";

type AppNavItem = {
  label: string;
  to:
    | "/home"
    | "/link"
    | "/store"
    | "/priority-dm"
    | "/calendar"
    | "/community"
    | "/email-marketing"
    | "/post-scheduler"
    | "/social-insights"
    | "/auto-dms"
    | "/content"
    | "/mcp"
    | "/earn";
  icon: LucideIcon;
  description: string;
  contentTab?: "agent" | "brain" | "discover";
  routines?: boolean;
};

type SidebarSearch = { tab?: unknown; routines?: unknown };

export const APP_NAV_ITEMS: ReadonlyArray<AppNavItem> = [
  { label: "Home", to: "/home", icon: House, description: "Your creator workspace" },
  { label: "Link", to: "/link", icon: Link2, description: "Edit your main page" },
  { label: "Store", to: "/store", icon: Store, description: "Products, orders and payouts" },
  {
    label: "Priority DM",
    to: "/priority-dm",
    icon: MessagesSquare,
    description: "Paid conversations and replies",
  },
  { label: "Calendar", to: "/calendar", icon: CalendarDays, description: "Sessions and bookings" },
  { label: "Community", to: "/community", icon: UsersRound, description: "Members and updates" },
  {
    label: "Email Marketing",
    to: "/email-marketing",
    icon: Mail,
    description: "Newsletters, broadcasts and audience",
  },
  {
    label: "Post Scheduler",
    to: "/post-scheduler",
    icon: CalendarClock,
    description: "Plan and publish content",
  },
  {
    label: "Social Insights",
    to: "/social-insights",
    icon: BarChart3,
    description: "Audience growth and content performance",
  },
  {
    label: "Auto DMs",
    to: "/auto-dms",
    icon: MessageCircleMore,
    description: "Instagram, Facebook and X",
  },
  {
    label: "Agent",
    to: "/content",
    icon: Bot,
    description: "Research, write and prepare content",
    contentTab: "agent",
  },
  {
    label: "Brain",
    to: "/content",
    icon: Brain,
    description: "Your context and content strategy",
    contentTab: "brain",
  },
  {
    label: "Routines",
    to: "/content",
    icon: Clock3,
    description: "Automated content preparation",
    contentTab: "agent",
    routines: true,
  },
  {
    label: "Discover",
    to: "/content",
    icon: Compass,
    description: "Ideas from your niche and winners",
    contentTab: "discover",
  },
  {
    label: "MCP",
    to: "/mcp",
    icon: Bot,
    description: "Connect your AI agent",
  },
  { label: "Earn", to: "/earn", icon: BadgeDollarSign, description: "Referrals and rewards" },
];

type SidebarProfile =
  | {
      display_name?: string | null;
      username?: string | null;
      avatar_url?: string | null;
    }
  | null
  | undefined;

export function AppSidebar({
  profile,
  workspaceSession,
  collapsed,
  onCollapsedChange,
}: {
  profile: SidebarProfile;
  workspaceSession?: WorkspaceSession | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const location = useRouterState({ select: (state) => state.location });
  const pathname = location.pathname;
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeMobileDialog = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    closeMobileDialog();
    desktop.addEventListener("change", closeMobileDialog);
    return () => desktop.removeEventListener("change", closeMobileDialog);
  }, []);

  return (
    <>
      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center border-b border-border bg-background/95 px-3 backdrop-blur-xl lg:hidden">
          <DialogPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label="Open app navigation"
              className="inline-flex size-10 items-center justify-center rounded-lg text-foreground hover:bg-accent"
            >
              <Menu className="size-5" />
            </button>
          </DialogPrimitive.Trigger>
        </header>

        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex h-dvh w-[min(14.5rem,86vw)] flex-col overflow-hidden border-r border-border bg-background p-2.5 shadow-2xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left lg:hidden">
            <DialogPrimitive.Title className="sr-only">App navigation</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Navigate between your Bento creator tools.
            </DialogPrimitive.Description>
            <SidebarPanel
              profile={profile}
              workspaceSession={workspaceSession}
              collapsed={false}
              mobile
              pathname={pathname}
              search={location.search}
              onNavigate={() => setMobileOpen(false)}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <aside
        aria-label="App navigation"
        onMouseEnter={() => onCollapsedChange(false)}
        onMouseLeave={() => onCollapsedChange(true)}
        onFocusCapture={() => onCollapsedChange(false)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onCollapsedChange(true);
        }}
        className={`sticky top-0 z-40 hidden h-screen shrink-0 flex-col border-r border-border bg-background p-2.5 shadow-none transition-[width] duration-300 lg:flex ${
          collapsed ? "w-16" : "w-[13.5rem]"
        }`}
      >
        <SidebarPanel
          profile={profile}
          workspaceSession={workspaceSession}
          collapsed={collapsed}
          mobile={false}
          pathname={pathname}
          search={location.search}
          onNavigate={() => undefined}
        />
      </aside>
    </>
  );
}

function SidebarPanel({
  profile,
  workspaceSession,
  collapsed,
  mobile,
  pathname: pathnameOverride,
  search,
  onNavigate,
}: {
  profile: SidebarProfile;
  workspaceSession?: WorkspaceSession | null;
  collapsed: boolean;
  mobile: boolean;
  pathname?: string;
  search?: SidebarSearch;
  onNavigate: () => void;
}) {
  const pathname = pathnameOverride ?? "/home";

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-1.5 px-0.5">
        <Link
          to="/home"
          aria-label="Bento home"
          onClick={onNavigate}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm text-foreground hover:bg-accent"
        >
          <BentoIcon className="size-7" />
          {!collapsed && <span className="truncate font-semibold">bento.surf</span>}
        </Link>
        {mobile && (
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              aria-label="Close app navigation"
              className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
            >
              <X className="size-3.5" />
            </button>
          </DialogPrimitive.Close>
        )}
      </div>

      <nav
        className="no-scrollbar mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pr-0.5"
        aria-label="Creator tools"
      >
        <div className="grid gap-1">
          {APP_NAV_ITEMS.slice(0, -1).map((item) => (
            <div
              key={item.label}
              className={
                item.to === "/link" || item.to === "/post-scheduler" || item.label === "Agent"
                  ? "mt-1.5 border-t border-border/70 pt-2.5"
                  : undefined
              }
            >
              <SidebarLink
                {...item}
                active={isNavItemActive(pathname, search, item)}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </div>
          ))}
        </div>
        <div className="mt-auto border-t border-border/70 pt-2.5">
          <SidebarLink
            {...APP_NAV_ITEMS.at(-1)!}
            active={pathname === "/earn"}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </div>
      </nav>

      <WorkspaceMenu session={workspaceSession} collapsed={collapsed} fallbackProfile={profile} />
    </>
  );
}

function isNavItemActive(pathname: string, search: SidebarSearch | undefined, item: AppNavItem) {
  if (item.contentTab) {
    const tab = typeof search?.tab === "string" ? search.tab : "discover";
    return (
      pathname === "/content" &&
      tab === item.contentTab &&
      Boolean(search?.routines) === Boolean(item.routines)
    );
  }
  return item.to === "/auto-dms" || item.to === "/email-marketing"
    ? pathname === item.to || pathname.startsWith(`${item.to}/`)
    : pathname === item.to;
}

function SidebarLink({
  label,
  to,
  icon: Icon,
  contentTab,
  routines,
  active,
  collapsed,
  onNavigate,
}: AppNavItem & {
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      to={to}
      search={contentTab ? { tab: contentTab, ...(routines ? { routines: true } : {}) } : undefined}
      onClick={onNavigate}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={`flex min-h-9 items-center gap-2.5 rounded-[8px] px-2.5 text-xs font-medium transition-[background-color,border-color,color,box-shadow] duration-150 ${
        active
          ? "border border-border/70 bg-card text-foreground shadow-sm"
          : "border border-transparent text-muted-foreground hover:bg-black/[0.035] hover:text-foreground dark:hover:bg-white/[0.06]"
      } ${collapsed ? "lg:justify-center lg:px-0" : ""}`}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
