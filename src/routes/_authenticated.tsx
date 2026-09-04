import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { getFeaturebaseIdentity } from "@/lib/featurebase.functions";
import { requireAuthenticatedCreator } from "@/lib/auth-entry";
import { getMyProfile } from "@/lib/profile.functions";
import { FeaturebaseHub } from "@/components/FeaturebaseHub";
import { FeaturebaseIdentitySync } from "@/components/FeaturebaseIdentitySync";
import { FontApplier } from "@/components/FontApplier";
import { AppSidebar } from "@/components/AppSidebar";
import { setBrowserTimeZoneOverride } from "@/lib/timezones";
import { configuredMcpEndpoint } from "@/lib/application-urls";
import { getFeaturebasePublicConfig } from "@/lib/instance-public-config";
import {
  bentoRemoteMcpSetup,
  requireWebMcpUserConfirmation,
  useWebMcpTools,
  webMcpResult,
  type WebMcpTool,
} from "@/lib/webmcp";
import { createAuthenticatedWebMcpTools } from "@/lib/webmcp-tools";

const WEBMCP_WORKSPACES = {
  home: "/home",
  link: "/link",
  store: "/store",
  email_marketing: "/email-marketing",
  priority_dm: "/priority-dm",
  calendar: "/calendar",
  community: "/community",
  post_scheduler: "/post-scheduler",
  social_insights: "/social-insights",
  analytics: "/social-insights",
  auto_dms: "/auto-dms",
  products: "/products",
  bookings: "/bookings",
  mcp: "/mcp",
  earn: "/earn",
  settings: "/settings",
} as const;

export const WEBMCP_TOOLS_BY_ROUTE: Record<string, readonly string[]> = {
  home: ["list_social_posts", "list_products", "list_bookings"],
  dashboard: ["list_social_posts", "list_products", "list_bookings"],
  link: ["list_pages", "manage_page", "manage_block", "manage_calendar", "update_profile"],
  store: [
    "list_products",
    "get_store_workspace",
    "upload_media",
    "manage_product",
    "manage_discount_code",
    "manage_order_bump",
    "manage_audience",
  ],
  "email-marketing": ["manage_audience"],
  products: ["list_products", "get_store_workspace", "manage_product"],
  calendar: [
    "list_bookings",
    "get_calendar_workspace",
    "upload_media",
    "manage_calendar",
    "manage_product",
  ],
  bookings: ["list_bookings", "get_calendar_workspace", "manage_calendar"],
  community: ["get_community_workspace", "manage_community", "manage_product"],
  "post-scheduler": [
    "list_social_accounts",
    "list_social_posts",
    "upload_media",
    "create_social_post",
  ],
  scheduler: ["list_social_accounts", "list_social_posts", "upload_media", "create_social_post"],
  "social-insights": ["list_social_accounts", "list_social_posts", "get_analytics_workspace"],
  analytics: ["list_social_accounts", "list_social_posts", "get_analytics_workspace"],
  "auto-dms": [
    "list_social_accounts",
    "list_auto_dm_automations",
    "save_auto_dm_automation",
    "set_auto_dm_enabled",
    "delete_auto_dm_automation",
  ],
  automations: [
    "list_social_accounts",
    "list_auto_dm_automations",
    "save_auto_dm_automation",
    "set_auto_dm_enabled",
    "delete_auto_dm_automation",
  ],
  earn: ["get_earn_workspace", "manage_earn"],
  settings: ["get_profile_workspace", "get_integration_workspace", "update_profile"],
  mcp: ["get_integration_workspace"],
  onboarding: ["get_profile_workspace", "manage_block", "update_profile"],
};

export function authenticatedWebMcpToolNames(pathname: string) {
  const route = pathname.split("/").filter(Boolean)[0] || "home";
  return new Set(["get_bento_overview", ...(WEBMCP_TOOLS_BY_ROUTE[route] || [])]);
}

export function createOpenWorkspaceWebMcpTool(
  openWorkspace: (
    path: (typeof WEBMCP_WORKSPACES)[keyof typeof WEBMCP_WORKSPACES],
  ) => unknown | Promise<unknown>,
): WebMcpTool {
  return {
    name: "bento_open_workspace",
    title: "Open Bento workspace",
    description:
      "Opens a named Bento creator workspace in the current tab so the user and agent can continue there together.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          enum: Object.keys(WEBMCP_WORKSPACES),
          description: "The Bento workspace to open.",
        },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      const workspace = input.workspace;
      if (typeof workspace !== "string" || !(workspace in WEBMCP_WORKSPACES)) {
        throw new Error("Choose a supported Bento workspace.");
      }
      const path = WEBMCP_WORKSPACES[workspace as keyof typeof WEBMCP_WORKSPACES];
      await requireWebMcpUserConfirmation("Open this Bento workspace", { workspace, path });
      signal.throwIfAborted();
      await openWorkspace(path);
      signal.throwIfAborted();
      return webMcpResult(`Opened the ${workspace.replaceAll("_", " ")} workspace.`, { path });
    },
  };
}

const FEATUREBASE_CONFIG = getFeaturebasePublicConfig(import.meta.env);
const FEATUREBASE_AUTH_IDENTITY_ENABLED =
  Boolean(FEATUREBASE_CONFIG) && import.meta.env.VITE_FEATUREBASE_IDENTIFY_ENABLED === "true";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  // Match the SSR pending shell immediately. defaultPendingMs: 1000 would hide
  // that shell on hydrate and leave a blank page until beforeLoad finishes.
  pendingMs: 0,
  staleTime: 5 * 60_000,
  beforeLoad: ({ location }) => requireAuthenticatedCreator(location.pathname, location.href),
  component: AuthLayout,
});

function AuthLayout() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const { resolvedTheme, setTheme } = useTheme();
  const { data: profile } = useQuery({
    queryKey: ["my-profile"],
    queryFn: () => getMyProfile(),
    staleTime: 60_000,
  });
  const { data: featurebaseIdentity } = useQuery({
    queryKey: ["featurebase-identity"],
    queryFn: () => getFeaturebaseIdentity(),
    staleTime: 45 * 60 * 1_000,
    refetchInterval: 45 * 60 * 1_000,
    enabled: FEATUREBASE_AUTH_IDENTITY_ENABLED,
  });
  const savedTheme = profile?.theme === "dark" ? "dark" : "light";
  const theme = profile ? savedTheme : resolvedTheme === "dark" ? "dark" : "light";
  const showSidebar = pathname !== "/onboarding";
  const compactAppUi = pathname !== "/link";

  useEffect(() => {
    if (!profile) return;
    setTheme(savedTheme);
    setBrowserTimeZoneOverride(profile.account_timezone);
  }, [profile, savedTheme, setTheme]);

  const webMcpTools = useMemo(() => {
    const refresh = async () => {
      await Promise.allSettled([router.invalidate(), queryClient.invalidateQueries()]);
    };
    const allowedNames = authenticatedWebMcpToolNames(pathname);
    return [
      ...createAuthenticatedWebMcpTools(refresh).filter((tool) => allowedNames.has(tool.name)),
      ...(pathname.startsWith("/mcp")
        ? [
            {
              name: "bento_get_mcp_setup_instructions",
              title: "Get Bento MCP setup instructions",
              description:
                "Returns Bento's remote MCP endpoint and concise setup steps for supported clients.",
              inputSchema: {
                type: "object",
                properties: {
                  client: {
                    type: "string",
                    enum: ["chatgpt", "claude", "cursor", "claude_code", "codex", "other"],
                    description: "Client to configure.",
                  },
                },
                required: ["client"],
                additionalProperties: false,
              },
              annotations: { readOnlyHint: true, untrustedContentHint: false },
              execute: (input: Record<string, unknown>) => {
                const client = input.client;
                if (
                  typeof client !== "string" ||
                  !["chatgpt", "claude", "cursor", "claude_code", "codex", "other"].includes(client)
                ) {
                  throw new Error("Choose a supported MCP client.");
                }
                const endpoint = configuredMcpEndpoint(import.meta.env.VITE_APP_URL);
                const setup = bentoRemoteMcpSetup(client, endpoint);
                return webMcpResult(`Loaded Bento MCP setup for ${client.replaceAll("_", " ")}.`, {
                  endpoint,
                  transport: "Streamable HTTP",
                  authentication: "OAuth 2.1 browser authorization",
                  setup,
                  instructionsPath: "/mcp",
                });
              },
            },
          ]
        : []),
      createOpenWorkspaceWebMcpTool((path) => navigate({ to: path })),
    ];
  }, [navigate, pathname, queryClient, router]);
  useWebMcpTools(webMcpTools);

  return (
    <>
      <FontApplier
        headline={profile?.secondary_font}
        body={profile?.primary_font}
        applyGlobalTokens={false}
      />
      <div
        data-theme={theme}
        className={`${theme === "dark" ? "dark" : ""} min-h-screen bg-background`}
      >
        {FEATUREBASE_CONFIG && (
          <FeaturebaseIdentitySync
            appId={FEATUREBASE_CONFIG.appId}
            enableAuthenticatedIdentity={FEATUREBASE_AUTH_IDENTITY_ENABLED}
            featurebaseJwt={featurebaseIdentity?.featurebaseJwt}
            theme={theme}
          />
        )}
        {showSidebar ? (
          <div
            className="flex min-h-screen"
            style={
              {
                "--app-sidebar-width": sidebarCollapsed ? "4rem" : "13.5rem",
              } as CSSProperties
            }
          >
            <AppSidebar
              profile={profile}
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
            />
            <div className={`min-w-0 flex-1 pt-14 lg:pt-0 ${compactAppUi ? "app-ui-compact" : ""}`}>
              <Outlet />
            </div>
          </div>
        ) : (
          <div className={compactAppUi ? "app-ui-compact" : undefined}>
            <Outlet />
          </div>
        )}
        {FEATUREBASE_CONFIG && (
          <FeaturebaseHub portalUrl={FEATUREBASE_CONFIG.portalUrl} inAppShell={showSidebar} />
        )}
      </div>
    </>
  );
}
