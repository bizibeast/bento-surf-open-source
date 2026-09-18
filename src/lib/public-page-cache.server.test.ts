import { describe, expect, it, vi } from "vitest";

import { isPublicPageRequest, storePublicPageCache } from "./public-page-cache.server";

function documentRequest(url: string, init?: RequestInit) {
  return new Request(url, {
    headers: { accept: "text/html", ...init?.headers },
    ...init,
  });
}

describe("public page cache boundary", () => {
  it("uses the unified-page cache generation for rendered HTML", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("caches", { default: { put } });
    await storePublicPageCache(
      documentRequest("http://localhost:8080/@bizibeast/store"),
      new Response("<html>Store</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      undefined,
    );
    expect(put.mock.calls[0][0].url).toContain("__bento_public_page_cache=v2");
    vi.unstubAllGlobals();
  });

  it("caches public Bento and product pages", () => {
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/"))).toBe(true);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/@bizibeast"))).toBe(true);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/@bizibeast/links"))).toBe(
      true,
    );
    expect(
      isPublicPageRequest(
        documentRequest("http://localhost:8080/@bizibeast/products/creator-course"),
      ),
    ).toBe(true);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/p/creator-course"))).toBe(
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
      expect(isPublicPageRequest(documentRequest(`http://localhost:8080${path}`))).toBe(false);
    }
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/api/health"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/login"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/reset-password"))).toBe(
      false,
    );
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/review/private-token"))).toBe(
      false,
    );
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/library/"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/payments/razorpay/id"))).toBe(
      false,
    );
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/calendar"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/community"))).toBe(false);
    expect(isPublicPageRequest(documentRequest("http://localhost:8080/link"))).toBe(false);
    expect(
      isPublicPageRequest(
        documentRequest("http://localhost:8080/@bizibeast", {
          headers: { accept: "text/html", cookie: "session=private" },
        }),
      ),
    ).toBe(false);
    expect(
      isPublicPageRequest(documentRequest("http://localhost:8080/@bizibeast", { method: "POST" })),
    ).toBe(false);
  });
});
