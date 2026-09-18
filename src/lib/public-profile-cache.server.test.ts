import { afterEach, expect, it, vi } from "vitest";
import { clearPublicProfileCache, publicProfileCacheKey } from "./public-profile-cache.server";

afterEach(() => vi.unstubAllGlobals());

it("clears the creator shell across hosted pages, system routes, and custom domains", async () => {
  const remove = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("caches", { default: { delete: remove } });
  await clearPublicProfileCache("Creator", ["about"], ["creator.example"]);
  const urls = remove.mock.calls.map(([request]) => request.url);
  expect(urls).toHaveLength(16);
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
    expect(urls).toContain(publicProfileCacheKey(null, ["Creator", ...suffix]));
    expect(urls).toContain(publicProfileCacheKey("creator.example", suffix));
  }
});
