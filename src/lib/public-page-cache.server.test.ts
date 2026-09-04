import { describe, expect, it } from "vitest";

import { isPublicPageRequest as classifyPublicPageRequest } from "./public-page-cache.server";

const instanceEnv = {
  VITE_APP_URL: "https://app.self.example",
  VITE_PUBLIC_URL: "https://public.self.example",
};

function isPublicPageRequest(request: Request, env = instanceEnv) {
  return classifyPublicPageRequest(request, env);
}

function documentRequest(url: string, init?: RequestInit) {
  return new Request(url, {
    headers: { accept: "text/html", ...init?.headers },
    ...init,
  });
}

describe("public page cache boundary", () => {
  it("classifies exact self-host app and public origins without trusting sibling origins", () => {
    const env = {
      VITE_APP_URL: "https://app.self.example",
      VITE_PUBLIC_URL: "https://public.self.example",
    };

    expect(isPublicPageRequest(documentRequest("https://app.self.example/home"), env)).toBe(false);
    expect(isPublicPageRequest(documentRequest("https://public.self.example/@creator"), env)).toBe(
      true,
    );
    expect(
      isPublicPageRequest(documentRequest("https://unrelated.self.example/p/product"), env),
    ).toBe(false);
  });

  it("caches public Bento and product pages", () => {
    expect(isPublicPageRequest(documentRequest("https://public.self.example/"))).toBe(true);
    expect(isPublicPageRequest(documentRequest("https://public.self.example/@creator"))).toBe(true);
    expect(isPublicPageRequest(documentRequest("https://public.self.example/@creator/links"))).toBe(
      true,
    );
    expect(
      isPublicPageRequest(
        documentRequest("https://public.self.example/@creator/products/creator-course"),
      ),
    ).toBe(true);
    expect(isPublicPageRequest(documentRequest("https://app.self.example/p/creator-course"))).toBe(
      true,
    );
    expect(isPublicPageRequest(documentRequest("https://creator.example/"))).toBe(true);
    expect(isPublicPageRequest(documentRequest("https://creator.example/about"))).toBe(true);
  });

  it("never caches authenticated, mutation, or application routes", () => {
    for (const path of [
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
    ]) {
      expect(isPublicPageRequest(documentRequest(`https://public.self.example${path}`))).toBe(
        false,
      );
    }
    expect(isPublicPageRequest(documentRequest("https://public.self.example/api/health"))).toBe(
      false,
    );
    expect(isPublicPageRequest(documentRequest("https://public.self.example/login"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("https://app.self.example/reset-password"))).toBe(
      false,
    );
    expect(
      isPublicPageRequest(documentRequest("https://app.self.example/review/private-token")),
    ).toBe(false);
    expect(isPublicPageRequest(documentRequest("https://app.self.example/library/"))).toBe(false);
    expect(
      isPublicPageRequest(documentRequest("https://app.self.example/payments/razorpay/id")),
    ).toBe(false);
    expect(isPublicPageRequest(documentRequest("https://app.self.example/calendar"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("https://app.self.example/community"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("https://app.self.example/link"))).toBe(false);
    expect(
      isPublicPageRequest(
        documentRequest("https://public.self.example/@creator", {
          headers: { accept: "text/html", cookie: "session=private" },
        }),
      ),
    ).toBe(false);
    expect(
      isPublicPageRequest(
        documentRequest("https://public.self.example/@creator", { method: "POST" }),
      ),
    ).toBe(false);
  });
});
