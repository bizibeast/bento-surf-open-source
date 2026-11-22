import { afterEach, expect, it, vi } from "vitest";
import { clearPublicProfileCache, publicProfileCacheKey } from "./public-profile-cache.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("clears both profile data and rendered documents for a creator's pages", async () => {
  vi.stubEnv("VITE_APP_URL", "https://app.example.com");
  vi.stubEnv("VITE_PUBLIC_URL", "https://example.com");
  const remove = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("caches", { default: { delete: remove } });
  await clearPublicProfileCache("Creator", ["about"], ["creator.example"]);
  const urls = remove.mock.calls.map(([request]) => request.url);
  for (const slug of [
    "",
    "calendar",
    "store",
    "products",
    "insights",
    "newsletter",
    "newsletters",
    "about",
  ]) {
    const suffix = slug ? [slug] : [];
    expect(urls).toContain(publicProfileCacheKey("example.com", ["Creator", ...suffix]));
    expect(urls).toContain(publicProfileCacheKey("app.example.com", ["Creator", ...suffix]));
    expect(urls).toContain(publicProfileCacheKey("creator.example", suffix));
    expect(urls).toContain(
      `https://example.com/@creator${slug ? `/${slug}` : ""}?__bento_public_page_cache=creator-v3`,
    );
    expect(urls).toContain(`https://creator.example/${slug}?__bento_public_page_cache=creator-v3`);
  }
});
