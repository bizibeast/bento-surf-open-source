import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) },
}));

import server, { handleDeploymentHealthRequest, withDeploymentHeaders } from "./server";

describe("deployment security headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["/api/tools/transcribe", "/api/tools/media"])(
    "does not expose removed public marketing endpoint %s",
    async (path) => {
      const env = {
        APP_ENV: "development",
        VITE_APP_URL: "https://self.example",
        VITE_PUBLIC_URL: "https://self.example",
      };
      const request = Object.assign(new Request(`https://self.example${path}`), {
        runtime: { cloudflare: { env } },
      }) as unknown as Parameters<typeof server.fetch>[0];

      expect((await server.fetch(request)).status).toBe(404);
    },
  );

  it.each([
    ["/robots.txt", "text/plain; charset=utf-8", "Sitemap: https://public.example/sitemap.xml"],
    ["/llms.txt", "text/plain; charset=utf-8", "MCP endpoint: /mcp"],
    ["/sitemap.xml", "application/xml; charset=utf-8", "<sitemapindex"],
  ])("serves %s as a crawler-readable file", async (path, contentType, content) => {
    const env = { VITE_PUBLIC_URL: "https://public.example" };
    const request = Object.assign(new Request(`https://public.example${path}`), {
      runtime: { cloudflare: { env } },
    }) as unknown as Parameters<typeof server.fetch>[0];

    const response = await server.fetch(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("cache-control")).toContain("max-age=300");
    expect(await response.text()).toContain(content);
  });

  it.each(["/sitemap.xml", "/sitemaps/profiles-0001.xml"])(
    "does not expose the platform sitemap on creator domains at %s",
    async (path) => {
      const request = new Request(`https://creator.example${path}`) as Parameters<
        typeof server.fetch
      >[0];

      const response = await server.fetch(request);

      expect(response.status).toBe(404);
    },
  );

  it("uses the configured public origin inside crawler documents", async () => {
    const env = { APP_ENV: "staging", VITE_PUBLIC_URL: "https://staging.example" };
    const request = (path: string) =>
      Object.assign(new Request(`https://staging.example${path}`), {
        runtime: { cloudflare: { env } },
      }) as unknown as Parameters<typeof server.fetch>[0];

    const response = await server.fetch(request("/sitemap.xml"));
    const xml = await response.text();
    const robots = await (await server.fetch(request("/robots.txt"))).text();

    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).not.toContain("<loc>https://bento.surf/");
    expect(robots).toContain("Sitemap: https://staging.example/sitemap.xml");
  });

  it("stores and reuses generated sitemaps through the edge cache", async () => {
    const cachedXml =
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://bento.surf/cached</loc></url></urlset>';
    const match = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(new Response(cachedXml, { status: 200 }));
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", { default: { match, put } });
    const request = () =>
      Object.assign(new Request("https://bento.surf/sitemap.xml"), {
        runtime: {
          cloudflare: {
            env: { APP_ENV: "production", VITE_PUBLIC_URL: "https://bento.surf" },
            context: { waitUntil: vi.fn() },
          },
        },
      }) as unknown as Parameters<typeof server.fetch>[0];

    await server.fetch(request());
    const cached = await server.fetch(request());

    expect(put).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledTimes(2);
    expect(await cached.text()).toContain("https://bento.surf/cached");
  });

  it.each([
    {
      env: { APP_ENV: "staging", VITE_PUBLIC_URL: "https://test.bento.surf" },
      authorization: undefined,
      expectedCacheControl: "no-store",
    },
    {
      env: { APP_ENV: "production", VITE_PUBLIC_URL: "https://bento.surf" },
      authorization: "Bearer crawler",
      expectedCacheControl: "private, no-store",
    },
  ])(
    "does not cache no-store sitemap requests",
    async ({ env, authorization, expectedCacheControl }) => {
      const match = vi.fn();
      const put = vi.fn();
      vi.stubGlobal("caches", { default: { match, put } });
      const headers = authorization ? { authorization } : undefined;
      const request = Object.assign(
        new Request(`${env.VITE_PUBLIC_URL}/sitemap.xml`, { headers }),
        { runtime: { cloudflare: { env, context: { waitUntil: vi.fn() } } } },
      ) as unknown as Parameters<typeof server.fetch>[0];

      const response = await server.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(expectedCacheControl);
      expect(match).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("sets a complete baseline CSP and transport protections", () => {
    const response = withDeploymentHeaders(
      new Response("ok"),
      {},
      new Request("https://app.bento.surf/link"),
    );
    const csp = response.headers.get("content-security-policy") ?? "";

    for (const directive of [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://maps.googleapis.com https://maps.gstatic.com https://static.cloudflareinsights.com https://us-assets.i.posthog.com https://challenges.cloudflare.com https://do.featurebase.app",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://us.i.posthog.com https://cloudflareinsights.com https://*.featurebase.app wss://ws.featurebase.app https://api.razorpay.com https://maps.googleapis.com https://maps.gstatic.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("https://*.posthog.com");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("keeps public pages indexable", () => {
    const response = withDeploymentHeaders(
      new Response("ok"),
      {},
      new Request("https://bento.surf/explore"),
    );

    expect(response.headers.has("x-robots-tag")).toBe(false);
  });

  it.each([
    ["https://public.example/tools", "public-token"],
    ["https://app.example/home", "app-token"],
  ])("serves the matching split-origin WebMCP token on %s", (url, token) => {
    const response = withDeploymentHeaders(
      new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      {
        VITE_PUBLIC_URL: "https://public.example",
        VITE_APP_URL: "https://app.example",
        WEBMCP_ORIGIN_TRIAL_TOKEN: "ignored-generic-token",
        WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN: "public-token",
        WEBMCP_APP_ORIGIN_TRIAL_TOKEN: "app-token",
      },
      new Request(url),
    );

    expect(response.headers.get("origin-trial")).toBe(token);
  });

  it.each([
    [
      {
        WEBMCP_APP_ORIGIN_TRIAL_TOKEN: "app-token",
        WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN: "public-token",
        WEBMCP_ORIGIN_TRIAL_TOKEN: "shared-token",
      },
      "app-token",
    ],
    [
      {
        WEBMCP_APP_ORIGIN_TRIAL_TOKEN: undefined,
        WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN: "public-token",
        WEBMCP_ORIGIN_TRIAL_TOKEN: "shared-token",
      },
      "public-token",
    ],
    [
      {
        WEBMCP_APP_ORIGIN_TRIAL_TOKEN: undefined,
        WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN: undefined,
        WEBMCP_ORIGIN_TRIAL_TOKEN: "shared-token",
      },
      "shared-token",
    ],
  ])("uses deterministic same-origin WebMCP token precedence", (tokens, expected) => {
    const response = withDeploymentHeaders(
      new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      {
        VITE_PUBLIC_URL: "https://self.example",
        VITE_APP_URL: "https://self.example",
        ...tokens,
      },
      new Request("https://self.example/home"),
    );

    expect(response.headers.get("origin-trial")).toBe(expected);
  });

  it("keeps Origin Trial tokens off APIs and unregistered origins", () => {
    const env = {
      VITE_PUBLIC_URL: "https://public.example",
      VITE_APP_URL: "https://app.example",
      WEBMCP_PUBLIC_ORIGIN_TRIAL_TOKEN: "public-token",
      WEBMCP_APP_ORIGIN_TRIAL_TOKEN: "app-token",
    };
    const api = withDeploymentHeaders(
      Response.json({ ok: true }),
      env,
      new Request("https://app.example/api/health"),
    );
    const customDomain = withDeploymentHeaders(
      new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      env,
      new Request("https://creator.example/home"),
    );
    const unregisteredSibling = withDeploymentHeaders(
      new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      env,
      new Request("https://other.public.example/home"),
    );

    expect(api.headers.has("origin-trial")).toBe(false);
    expect(customDomain.headers.has("origin-trial")).toBe(false);
    expect(unregisteredSibling.headers.has("origin-trial")).toBe(false);
  });

  it("keeps the Origin Trial token off the real HTML unsubscribe API", async () => {
    const env = {
      VITE_PUBLIC_URL: "https://self.example",
      VITE_APP_URL: "https://self.example",
      WEBMCP_ORIGIN_TRIAL_TOKEN: "shared-token",
    };
    const request = Object.assign(
      new Request("https://self.example/api/email/unsubscribe?token=invalid"),
      { runtime: { cloudflare: { env } } },
    ) as unknown as Parameters<typeof server.fetch>[0];

    const response = await server.fetch(request);

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.has("origin-trial")).toBe(false);
  });

  it.each([
    ["missing", {}],
    ["invalid", { VITE_PUBLIC_URL: "not a URL", VITE_APP_URL: "not a URL" }],
  ])("does not authorize localhost from %s origin configuration", (_name, origins) => {
    const response = withDeploymentHeaders(
      new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      { ...origins, WEBMCP_ORIGIN_TRIAL_TOKEN: "shared-token" },
      new Request("http://localhost:8080/home"),
    );

    expect(response.headers.has("origin-trial")).toBe(false);
  });

  it.each([
    "/reset-password",
    "/library/",
    "/calendar",
    "/community",
    "/review/token",
    "/p/creator-launch-kit/success",
    "/@creator/products/launch-kit/success",
  ])("prevents framing and caching sensitive route %s", (path) => {
    const response = withDeploymentHeaders(
      new Response("ok"),
      {},
      new Request(`https://app.bento.surf${path}`),
    );

    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("deployment health boundary", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects %s requests", async (method) => {
    const response = await handleDeploymentHealthRequest(
      new Request("https://app.bento.surf/api/health", { method }),
      {},
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    await expect(response.json()).resolves.toEqual({ error: "Method not allowed" });
  });

  it("allows bodyless health probes", async () => {
    const response = await handleDeploymentHealthRequest(
      new Request("https://app.bento.surf/api/health", { method: "HEAD" }),
      {},
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  it("keeps provider readiness private unless the operational token matches", async () => {
    const token = "a-secure-health-token-that-is-long-enough";
    const request = (authorization?: string) =>
      new Request("https://app.bento.surf/api/health", {
        headers: authorization ? { authorization } : undefined,
      });
    const env = { HEALTH_CHECK_TOKEN: token };

    const publicResponse = await handleDeploymentHealthRequest(request(), env);
    const wrongTokenResponse = await handleDeploymentHealthRequest(
      request("Bearer wrong-token"),
      env,
    );
    const detailedResponse = await handleDeploymentHealthRequest(request(`Bearer ${token}`), env);

    expect(await publicResponse.json()).toEqual({ ok: false });
    expect(await wrongTokenResponse.json()).toEqual({ ok: false });
    expect(await detailedResponse.json()).toMatchObject({ checks: expect.any(Object) });
  });

  it("fails Dodo runtime readiness when any add-on ID is missing", async () => {
    const token = "a-secure-health-token-that-is-long-enough";
    const addonKeys = [
      ...[5_000, 10_000, 25_000, 50_000, 100_000, 150_000].flatMap((tier) =>
        ["MONTHLY", "YEARLY"].map((period) => `DODO_CONTACT_TIER_${tier}_${period}_ADDON_ID`),
      ),
      "DODO_STORAGE_10GB_MONTHLY_ADDON_ID",
      "DODO_STORAGE_10GB_YEARLY_ADDON_ID",
    ];
    const configuredEnv = {
      HEALTH_CHECK_TOKEN: token,
      DODO_PAYMENTS_API_KEY: "dodo-key",
      DODO_PAYMENTS_WEBHOOK_KEY: "dodo-webhook",
      DODO_STORE_MONTHLY_PRODUCT_ID: "store-monthly",
      DODO_STORE_YEARLY_PRODUCT_ID: "store-yearly",
      DODO_CREATOR_MONTHLY_PRODUCT_ID: "creator-monthly",
      DODO_CREATOR_YEARLY_PRODUCT_ID: "creator-yearly",
      ...Object.fromEntries(addonKeys.map((key) => [key, `configured-${key}`])),
    };
    const request = () =>
      new Request("https://app.bento.surf/api/health", {
        headers: { authorization: `Bearer ${token}` },
      });

    const configured = (await (
      await handleDeploymentHealthRequest(request(), configuredEnv)
    ).json()) as { checks: { dodoBilling: boolean } };
    expect(configured.checks.dodoBilling).toBe(true);

    for (const missingKey of addonKeys) {
      const env: Record<string, unknown> = { ...configuredEnv };
      delete env[missingKey];
      const missing = (await (await handleDeploymentHealthRequest(request(), env)).json()) as {
        checks: { dodoBilling: boolean };
      };
      expect(missing.checks.dodoBilling, missingKey).toBe(false);
    }

    const whitespaceEnv = {
      ...configuredEnv,
      DODO_STORAGE_10GB_YEARLY_ADDON_ID: "   ",
    };
    const whitespace = (await (
      await handleDeploymentHealthRequest(request(), whitespaceEnv)
    ).json()) as { checks: { dodoBilling: boolean } };
    expect(whitespace.checks.dodoBilling).toBe(false);

    const duplicateEnv = {
      ...configuredEnv,
      DODO_STORAGE_10GB_YEARLY_ADDON_ID: (configuredEnv as Record<string, string>)
        .DODO_CONTACT_TIER_5000_MONTHLY_ADDON_ID,
    };
    const duplicate = (await (
      await handleDeploymentHealthRequest(request(), duplicateEnv)
    ).json()) as { checks: { dodoBilling: boolean } };
    expect(duplicate.checks.dodoBilling).toBe(false);
  });
});
