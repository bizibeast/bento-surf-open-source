import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { HoverGuide } from "@/components/HoverGuide";
import { shouldInvalidateRouterForAuthEvent } from "@/lib/auth-route-refresh";
import { configuredPublicOrigin } from "@/lib/application-urls";
import { DEFAULT_OPEN_GRAPH_IMAGE_PATH, DEFAULT_OPEN_GRAPH_IMAGE_VERSION } from "@/lib/open-graph";
import { safeWebMcpPathname, useWebMcpTools, webMcpResult } from "@/lib/webmcp";

// After a deploy, tabs loaded against the previous asset manifest 404 when they
// lazy-load a chunk (hashed filenames change), leaving dead UI - e.g. the dock's
// "+" silently failing to open the block picker. Vite surfaces those failures as
// vite:preloadError; reload once to pick up the fresh manifest.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    const key = "chunk-reload-at";
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 30_000) return; // avoid reload loops
    sessionStorage.setItem(key, String(Date.now()));
    event.preventDefault();
    window.location.reload();
  });
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-display text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-medium">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

// A failed dynamic import after a deploy (hashed chunk 404s because the manifest
// changed) throws here rather than firing vite:preloadError. Reload once to fetch
// the current manifest instead of stranding the user on the error screen.
function isChunkLoadError(error: Error) {
  const msg = error?.message ?? "";
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const publicMessage =
    import.meta.env.DEV && error?.message
      ? error.message
      : "This page could not load. Please try again.";

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isChunkLoadError(error)) {
      const key = "chunk-reload-at";
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (Date.now() - last >= 30_000) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
        return;
      }
    }
    void import("@/lib/posthog")
      .then(({ captureProductException }) => {
        captureProductException(error, {
          surface: "route_error_boundary",
          path: window.location.pathname,
        });
      })
      .catch((loadError) => {
        console.error("[Analytics] Error reporting could not load.", loadError);
      });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-medium">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{publicMessage}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-lg border border-input px-5 py-2.5 text-sm font-medium hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => {
    const appName = import.meta.env.VITE_APP_NAME?.trim() || "Bento Surf";
    const publicOrigin = configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL);
    const previewImage =
      import.meta.env.VITE_PREVIEW_IMAGE_URL?.trim() ||
      `${publicOrigin}${DEFAULT_OPEN_GRAPH_IMAGE_PATH}?v=${DEFAULT_OPEN_GRAPH_IMAGE_VERSION}`;
    const description = "A self-hostable creator business application.";

    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "theme-color", content: "#f7f8fc" },
        { title: appName },
        { name: "description", content: description },
        { name: "author", content: appName },
        { property: "og:site_name", content: appName },
        { property: "og:title", content: appName },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { property: "og:image", content: previewImage },
        { property: "og:image:secure_url", content: previewImage },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:width", content: "512" },
        { property: "og:image:height", content: "512" },
        { property: "og:image:alt", content: `${appName} preview` },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: previewImage },
        { name: "twitter:image:alt", content: `${appName} preview` },
        ...(import.meta.env.VITE_APP_ENV === "staging"
          ? [{ name: "robots", content: "noindex, nofollow, noarchive" }]
          : []),
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "icon", href: "/favicon.ico?v=20260727", sizes: "any" },
        {
          rel: "icon",
          type: "image/png",
          sizes: "32x32",
          href: "/favicon-32x32.png?v=20260727",
        },
        {
          rel: "icon",
          type: "image/png",
          sizes: "16x16",
          href: "/favicon-16x16.png?v=20260727",
        },
        {
          rel: "apple-touch-icon",
          sizes: "180x180",
          href: "/apple-touch-icon.png?v=20260727",
        },
        { rel: "manifest", href: "/manifest.webmanifest?v=20260727" },
        {
          rel: "preload",
          href: "/fonts/inter-latin.woff2",
          as: "font",
          type: "font/woff2",
          crossOrigin: "anonymous",
        },
        {
          rel: "preload",
          href: "/fonts/instrument-serif-latin.woff2",
          as: "font",
          type: "font/woff2",
          crossOrigin: "anonymous",
        },
      ],
    };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const authenticatedWorkspace = useRouterState({
    select: (state) =>
      state.matches.some((match) => String(match.routeId).startsWith("/_authenticated")),
  });
  const rectangularUi = authenticatedWorkspace && pathname !== "/link";

  useEffect(() => {
    document.documentElement.classList.toggle("app-ui-rectangular", rectangularUi);
    return () => document.documentElement.classList.remove("app-ui-rectangular");
  }, [rectangularUi]);

  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_current_page",
        title: "Get current Bento page",
        description:
          "Returns the current Bento page, browser title, and whether it is an authenticated creator workspace.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the current Bento page.", {
            path: safeWebMcpPathname(pathname),
            title: document.title,
            authenticatedWorkspace,
          }),
      },
    ],
    [authenticatedWorkspace, pathname],
  );
  useWebMcpTools(webMcpTools);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <ProductAnalyticsSync />
        <AuthSync />
        <div className={rectangularUi ? "app-ui-rectangular" : undefined}>
          <Outlet />
        </div>
        <HoverGuide />
        <Toaster position="top-center" richColors />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function AuthSync() {
  const router = useRouter();
  const queryClient = useQueryClient();
  useEffect(() => {
    let disposed = false;
    let lastUserId: string | null | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    void Promise.all([import("@/integrations/supabase/client"), import("@/lib/auth-entry")])
      .then(([{ supabase }, { clearOnboardedCache }]) => {
        if (disposed) return;
        const identifyProductUser = (userId: string | null) => {
          void import("@/lib/posthog")
            .then(({ identifyProductUser: identify }) => identify(userId))
            .catch((error) => {
              if (!disposed) console.error("[Analytics] User identity could not load.", error);
            });
        };

        const {
          data: { subscription },
        } = supabase.auth.onAuthStateChange((event, session) => {
          const sessionUserId = session?.user.id ?? null;
          identifyProductUser(sessionUserId);

          // Supabase invokes this callback while it is still committing the auth
          // transaction. Invalidating TanStack Router synchronously can make the
          // authenticated beforeLoad call re-enter getSession() during that
          // transaction and leave the route in a blank pending state after OAuth.
          // Session recovery on refresh also emits SIGNED_IN for the same user;
          // invalidating that handshake blanks ssr:false pages.
          const { invalidate, nextUserId } = shouldInvalidateRouterForAuthEvent(
            event,
            sessionUserId,
            lastUserId,
          );
          lastUserId = nextUserId;
          if (!invalidate) return;
          if (event === "SIGNED_OUT") clearOnboardedCache();
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            if (disposed) return;
            void Promise.allSettled([router.invalidate(), queryClient.invalidateQueries()]);
          }, 0);
        });
        unsubscribe = () => subscription.unsubscribe();

        return supabase.auth.getSession().then(({ data }) => {
          if (!disposed) identifyProductUser(data.session?.user.id ?? null);
        });
      })
      .catch((error) => {
        if (!disposed) console.error("[Auth] Session synchronization could not load.", error);
      });

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe?.();
    };
  }, [router, queryClient]);
  return null;
}

function ProductAnalyticsSync() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    let disposed = false;

    void import("@/lib/posthog")
      .then(
        ({
          captureProductPageview,
          isHeatmapProductPath,
          isReplayableProductPath,
          isTrackedProductPath,
          setProductHeatmaps,
          setProductSessionRecording,
        }) => {
          if (disposed) return;
          const tracked = isTrackedProductPath(pathname);
          setProductSessionRecording(isReplayableProductPath(pathname));
          setProductHeatmaps(isHeatmapProductPath(pathname));
          if (tracked) captureProductPageview(pathname);
        },
      )
      .catch((error) => {
        if (!disposed) console.error("[Analytics] Product analytics could not load.", error);
      });

    return () => {
      disposed = true;
    };
  }, [pathname]);

  return null;
}
