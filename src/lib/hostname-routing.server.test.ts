import { describe, expect, it } from "vitest";
import { routeCanonicalHostname } from "./hostname-routing.server";

const production = {
  VITE_APP_URL: "https://app.bento.surf",
  VITE_PUBLIC_URL: "https://bento.surf",
};

function destination(url: string) {
  const response = routeCanonicalHostname(new Request(url), production);
  return response ? { status: response.status, location: response.headers.get("location") } : null;
}

describe("canonical hostname routing", () => {
  it("leaves same-origin routes to the application router", () => {
    const singleOrigin = {
      VITE_APP_URL: "https://self.example",
      VITE_PUBLIC_URL: "https://self.example",
    };

    expect(
      routeCanonicalHostname(new Request("https://self.example/explore"), singleOrigin),
    ).toBeNull();
    expect(routeCanonicalHostname(new Request("https://self.example/"), singleOrigin)).toBeNull();
  });

  it("redirects HTTP URLs directly to their final HTTPS origin", () => {
    expect(destination("http://bento.surf/")).toEqual({
      status: 308,
      location: "https://bento.surf/",
    });
    expect(destination("http://bento.surf/settings?section=plan")).toEqual({
      status: 308,
      location: "https://app.bento.surf/settings?section=plan",
    });
    expect(destination("http://app.bento.surf/api/health")).toEqual({
      status: 308,
      location: "https://app.bento.surf/api/health",
    });
  });

  it.each([
    "/home",
    "/link",
    "/store",
    "/calendar",
    "/community",
    "/post-scheduler",
    "/social-insights",
    "/auto-dms",
    "/mcp",
    "/earn",
    "/settings",
  ])("moves %s to the app origin", (path) => {
    expect(destination(`https://bento.surf${path}`)).toEqual({
      status: 308,
      location: `https://app.bento.surf${path}`,
    });
  });

  it("moves signed-in application paths to the app origin", () => {
    expect(destination("https://bento.surf/settings?section=plan")).toEqual({
      status: 308,
      location: "https://app.bento.surf/settings?section=plan",
    });
    expect(destination("https://bento.surf/mcp")).toEqual({
      status: 308,
      location: "https://app.bento.surf/mcp",
    });
  });

  it.each([
    ["/dashboard", "/link"],
    ["/products", "/store"],
    ["/bookings", "/calendar"],
    ["/scheduler", "/post-scheduler"],
    ["/automations/instagram", "/auto-dms/instagram"],
  ])("redirects legacy %s URLs to %s", (legacy, canonical) => {
    expect(destination(`https://app.bento.surf${legacy}?from=bookmark`)).toEqual({
      status: 308,
      location: `https://app.bento.surf${canonical}?from=bookmark`,
    });
    expect(destination(`https://bento.surf${legacy}?from=bookmark`)).toEqual({
      status: 308,
      location: `https://app.bento.surf${canonical}?from=bookmark`,
    });
  });

  it("keeps marketing and collision-free creator pages on the public origin", () => {
    expect(destination("https://bento.surf/explore")).toBeNull();
    expect(destination("https://bento.surf/compare/linktree")).toBeNull();
    expect(destination("https://bento.surf/alternatives/linktree")).toBeNull();
    expect(destination("https://bento.surf/use-cases/coaches-and-consultants")).toBeNull();
    expect(destination("https://bento.surf/@explore")).toBeNull();
    expect(destination("https://bento.surf/sitemaps/profiles-0001.xml")).toBeNull();
  });

  it("keeps public products canonical while sending purchase success to the app", () => {
    expect(destination("https://bento.surf/p/creator-launch-kit")).toBeNull();
    expect(destination("https://app.bento.surf/p/creator-launch-kit")).toEqual({
      status: 308,
      location: "https://bento.surf/p/creator-launch-kit",
    });
    expect(destination("https://bento.surf/p/creator-launch-kit/success")).toEqual({
      status: 308,
      location: "https://app.bento.surf/p/creator-launch-kit/success",
    });
    expect(destination("https://bento.surf/@creator/products/launch-kit")).toBeNull();
    expect(destination("https://app.bento.surf/@creator/products/launch-kit")).toEqual({
      status: 308,
      location: "https://bento.surf/@creator/products/launch-kit",
    });
    expect(destination("https://bento.surf/@creator/products/launch-kit/success?order=1")).toEqual({
      status: 308,
      location: "https://app.bento.surf/@creator/products/launch-kit/success?order=1",
    });
    expect(destination("https://app.bento.surf/@creator/products/launch-kit/success")).toBeNull();
  });

  it("permanently preserves legacy creator links", () => {
    expect(destination("https://bento.surf/bizibeast/links?ref=old")).toEqual({
      status: 308,
      location: "https://bento.surf/@bizibeast/links?ref=old",
    });
  });

  it("sends marketing URLs opened on the app origin back to the public site", () => {
    expect(destination("https://app.bento.surf/explore?q=design")).toEqual({
      status: 308,
      location: "https://bento.surf/explore?q=design",
    });
    expect(destination("https://app.bento.surf/tools/hashtag-generator")).toEqual({
      status: 308,
      location: "https://bento.surf/tools/hashtag-generator",
    });
    expect(destination("https://app.bento.surf/compare/linktree")).toEqual({
      status: 308,
      location: "https://bento.surf/compare/linktree",
    });
    expect(destination("https://app.bento.surf/alternatives/linktree")).toEqual({
      status: 308,
      location: "https://bento.surf/alternatives/linktree",
    });
    expect(destination("https://app.bento.surf/use-cases/coaches-and-consultants")).toEqual({
      status: 308,
      location: "https://bento.surf/use-cases/coaches-and-consultants",
    });
    expect(destination("https://app.bento.surf/llms.txt")).toEqual({
      status: 308,
      location: "https://bento.surf/llms.txt",
    });
    expect(destination("https://app.bento.surf/sitemaps/products-0001.xml")).toEqual({
      status: 308,
      location: "https://bento.surf/sitemaps/products-0001.xml",
    });
    expect(destination("https://app.bento.surf/sitemap.xml")).toEqual({
      status: 308,
      location: "https://bento.surf/sitemap.xml",
    });
  });

  it("uses temporary navigation for the app root and mirrors staging origins", () => {
    expect(destination("https://app.bento.surf/?from=bookmark")).toEqual({
      status: 307,
      location: "https://app.bento.surf/link?from=bookmark",
    });
    const staging = {
      VITE_APP_URL: "https://app.test.bento.surf",
      VITE_PUBLIC_URL: "https://test.bento.surf",
    };
    const response = routeCanonicalHostname(
      new Request("https://test.bento.surf/login?next=%2Fdashboard"),
      staging,
    );
    expect(response?.headers.get("location")).toBe(
      "https://app.test.bento.surf/login?next=%2Fdashboard",
    );
  });

  it("keeps provider callbacks compatible on either origin", () => {
    expect(destination("https://bento.surf/api/webhooks/resend")).toBeNull();
    expect(destination("https://app.bento.surf/api/webhooks/resend")).toBeNull();
  });

  it("does not redirect APIs, webhooks, media, or custom domains", () => {
    expect(destination("https://bento.surf/api/webhooks/stripe")).toBeNull();
    expect(destination("https://bento.surf/cdn/avatar.png")).toBeNull();
    expect(
      routeCanonicalHostname(new Request("https://creator.example/settings"), production),
    ).toBeNull();
  });
});
