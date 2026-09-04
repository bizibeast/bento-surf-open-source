import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  CalendarClock,
  CalendarDays,
  House,
  BadgeDollarSign,
  Bot,
  Link2,
  Mail,
  Menu,
  MessageCircleMore,
  MessagesSquare,
  Settings,
  Store,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { DecodedImage } from "@/components/DecodedImage";
import { BentoIcon } from "@/components/BentoBrand";
import { getInstancePublicConfig } from "@/lib/instance-public-config";
import { safeMediaUrl } from "@/lib/safe-url";

export const APP_NAV_ITEMS = [
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
    label: "MCP",
    to: "/mcp",
    icon: Bot,
    description: "Connect your AI agent",
  },
  { label: "Earn", to: "/earn", icon: BadgeDollarSign, description: "Referrals and rewards" },
] as const satisfies ReadonlyArray<{
  label: string;
  to: string;
  icon: LucideIcon;
  description: string;
}>;

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
  collapsed,
  onCollapsedChange,
}: {
  profile: SidebarProfile;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
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
          <DialogPrimitive.Overlay className="fixed inset-0 z-[59] bg-black/25 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-[60] flex h-dvh w-[min(14.5rem,86vw)] flex-col overflow-hidden border-r border-border bg-background p-2.5 shadow-2xl outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left lg:hidden">
            <DialogPrimitive.Title className="sr-only">App navigation</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Navigate between your Bento creator tools.
            </DialogPrimitive.Description>
            <SidebarPanel
              profile={profile}
              collapsed={false}
              mobile
              pathname={pathname}
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
          collapsed={collapsed}
          mobile={false}
          pathname={pathname}
          onNavigate={() => undefined}
        />
      </aside>
    </>
  );
}

function SidebarPanel({
  profile,
  collapsed,
  mobile,
  pathname: pathnameOverride,
  onNavigate,
}: {
  profile: SidebarProfile;
  collapsed: boolean;
  mobile: boolean;
  pathname?: string;
  onNavigate: () => void;
}) {
  const pathname = pathnameOverride ?? "/home";
  const { sourceUrl } = getInstancePublicConfig(import.meta.env);

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
        className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pr-0.5"
        aria-label="Creator tools"
      >
        <div className="grid gap-1">
          {APP_NAV_ITEMS.slice(0, -1).map((item) => (
            <div
              key={item.to}
              className={
                item.to === "/link" || item.to === "/post-scheduler" || item.to === "/mcp"
                  ? "mt-1.5 border-t border-border/70 pt-2.5"
                  : undefined
              }
            >
              <SidebarLink
                {...item}
                active={isNavItemActive(pathname, item.to)}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            </div>
          ))}
        </div>
        <div className="mt-auto border-t border-border/70 pt-2.5">
          <SidebarLink
            {...APP_NAV_ITEMS.at(-1)!}
            active={isNavItemActive(pathname, "/earn")}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </div>
      </nav>

      <ProfileCard profile={profile} collapsed={collapsed} />
      {sourceUrl && (
        <a
          href={sourceUrl}
          className="mt-2 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          rel="noreferrer"
        >
          Source
        </a>
      )}
    </>
  );
}

function isNavItemActive(pathname: string, to: (typeof APP_NAV_ITEMS)[number]["to"]) {
  return to === "/auto-dms" || to === "/email-marketing"
    ? pathname === to || pathname.startsWith(`${to}/`)
    : pathname === to;
}

function SidebarLink({
  label,
  to,
  icon: Icon,
  active,
  collapsed,
  onNavigate,
}: (typeof APP_NAV_ITEMS)[number] & {
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      to={to}
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

function ProfileCard({ profile, collapsed }: { profile: SidebarProfile; collapsed: boolean }) {
  const name = profile?.display_name?.trim() || profile?.username || "Your profile";
  const avatarUrl = safeMediaUrl(profile?.avatar_url);
  return (
    <div
      className={`mt-2 flex items-center gap-2 rounded-lg border border-border bg-card p-1.5 ${
        collapsed ? "lg:flex-col" : ""
      }`}
    >
      {avatarUrl ? (
        <DecodedImage src={avatarUrl} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent font-ui-display text-base text-foreground">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-foreground">{name}</div>
          {profile?.username && (
            <div className="truncate text-[10px] text-muted-foreground">@{profile.username}</div>
          )}
        </div>
      )}
      {!collapsed && (
        <Link
          to="/settings"
          aria-label="Settings"
          title="Settings"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Settings className="size-3.5" />
        </Link>
      )}
    </div>
  );
}
