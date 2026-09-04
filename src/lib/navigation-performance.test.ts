import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routerSource = resolve(process.cwd(), "src/router.tsx");
const authLayoutSource = resolve(process.cwd(), "src/routes/_authenticated.tsx");
const tabMotionSource = resolve(process.cwd(), "src/components/MicroAppPanel.tsx");
const dashboardSource = resolve(process.cwd(), "src/routes/_authenticated/link.tsx");
const sidebarSource = resolve(process.cwd(), "src/components/AppSidebar.tsx");
const stylesSource = resolve(process.cwd(), "src/styles.css");
const rootSource = resolve(process.cwd(), "src/routes/__root.tsx");
const fastAppRoutes = [
  "home",
  "social-insights",
  "post-scheduler",
  "calendar",
  "community",
  "auto-dms.instagram",
  "auto-dms.twitter",
  "auto-dms.facebook",
].map((route) => resolve(process.cwd(), `src/routes/_authenticated/${route}.tsx`));

describe("authenticated navigation performance", () => {
  it("does not replace the current page with a loader for short in-app navigations", async () => {
    const source = await readFile(routerSource, "utf8");
    expect(source).toContain("defaultPendingMs: 1000");
    expect(source).toContain("defaultPendingMinMs: 0");
    expect(source).toContain("staleTime: 2 * 60_000");
    expect(source).toContain("refetchOnWindowFocus: false");
  });

  it("starts authenticated page prefetches without blocking the destination shell", async () => {
    const sources = await Promise.all(fastAppRoutes.map((route) => readFile(route, "utf8")));

    for (const source of sources) {
      expect(source).toMatch(/loader: \(\{ context[^}]*\}\) => \{/);
    }
  });

  it("keeps publish feedback animated through queueing and provider completion", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/routes/_authenticated/post-scheduler.tsx"),
      "utf8",
    );

    expect(source).toContain("setPublishingPostId(next.queuedPostId)");
    expect(source).toContain('toast.success("Post published")');
    expect(source).toContain("data-[state=closed]:slide-out-to-bottom-2");
    expect(source).toContain("motion-reduce:animate-none");
  });

  it("shows the pending shell immediately on authenticated refresh instead of a blank page", async () => {
    const source = await readFile(authLayoutSource, "utf8");
    expect(source).toContain("ssr: false");
    expect(source).toContain("pendingMs: 0");
  });

  it("does not client-only render public auth pages so refresh can SSR the form", async () => {
    const login = await readFile(resolve(process.cwd(), "src/routes/login.tsx"), "utf8");
    const signup = await readFile(resolve(process.cwd(), "src/routes/signup.tsx"), "utf8");
    expect(login).not.toContain("ssr: false");
    expect(signup).not.toContain("ssr: false");
  });

  it("does not treat a recovered stale session as a fresh login", async () => {
    const login = await readFile(resolve(process.cwd(), "src/routes/login.tsx"), "utf8");
    expect(login).not.toContain("onAuthStateChange");
  });

  it("keeps the route pending mark free of motion/react so hydration cannot blank the page", async () => {
    const loader = await readFile(resolve(process.cwd(), "src/components/BentoLoader.tsx"), "utf8");
    const mark = await readFile(
      resolve(process.cwd(), "src/components/BentoLoaderMark.tsx"),
      "utf8",
    );
    expect(loader).not.toContain("motion/react");
    expect(mark).not.toContain("animateTransform");
    expect(mark).toContain("bento-loader-card");
    expect(mark).toContain("setMotionEnabled(true)");
  });

  it("caches the authenticated gate instead of querying profiles on every app switch", async () => {
    const source = await readFile(authLayoutSource, "utf8");
    expect(source).toContain("requireAuthenticatedCreator");
    expect(source).not.toContain('.from("profiles")');
  });

  it("avoids CSS filter blur on micro-app tab transitions", async () => {
    const source = await readFile(tabMotionSource, "utf8");
    expect(source).not.toContain("filter:");
    expect(source).not.toContain("blur(");
  });

  it("uses one collapsible app sidebar instead of dashboard-only creator tools", async () => {
    const [sidebar, dashboard] = await Promise.all([
      readFile(sidebarSource, "utf8"),
      readFile(dashboardSource, "utf8"),
    ]);
    expect(sidebar).toContain("onMouseEnter={() => onCollapsedChange(false)}");
    expect(sidebar).toContain("onMouseLeave={() => onCollapsedChange(true)}");
    expect(sidebar).toContain('collapsed ? "w-16" : "w-[13.5rem]"');
    expect(sidebar).toContain('to: "/link"');
    expect(sidebar).toContain("<ProfileCard");
    expect(dashboard).not.toContain("CreatorToolLink");
  });

  it("keeps compact app controls out of the Link editor", async () => {
    const [layout, root, styles] = await Promise.all([
      readFile(authLayoutSource, "utf8"),
      readFile(rootSource, "utf8"),
      readFile(stylesSource, "utf8"),
    ]);
    expect(layout).toContain('const compactAppUi = pathname !== "/link"');
    expect(root).toContain('String(match.routeId).startsWith("/_authenticated")');
    expect(styles).toContain(".app-ui-rectangular");
    expect(styles).toContain("[data-bento-public-page] *");
  });

  it("keeps Supabase and PostHog out of the shared root bundle", async () => {
    const source = await readFile(rootSource, "utf8");
    expect(source).not.toContain('from "@/integrations/supabase/client"');
    expect(source).not.toContain('from "@/lib/posthog"');
    expect(source).not.toContain('from "@/lib/auth-entry"');
    expect(source).toContain('import("@/integrations/supabase/client")');
    expect(source).toContain('import("@/lib/posthog")');
    expect(source).toContain('import("@/lib/auth-entry")');
    expect(source).toContain("/fonts/inter-latin.woff2");
    expect(source).toContain("/fonts/instrument-serif-latin.woff2");
    expect(source).not.toContain("fonts.googleapis.com/css2");
  });

  it("splits route loaders out of the shared router entry", async () => {
    const vite = await readFile(resolve(process.cwd(), "vite.config.ts"), "utf8");
    expect(vite).toContain('["loader"]');
  });
});
