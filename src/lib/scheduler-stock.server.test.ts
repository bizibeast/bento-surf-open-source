import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  store: vi.fn(),
  register: vi.fn(),
  resolve: vi.fn(),
  head: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: m.limit,
  readResponseText: async (r: Response) => r.text(),
  readResponseBytes: async (r: Response) => new Uint8Array(await r.arrayBuffer()),
}));
vi.mock("./content-media.server", () => ({
  storeGeneratedContentMedia: m.store,
  importedMediaType: () => ({ mimeType: "image/jpeg" }),
}));
vi.mock("./content-agent-media.server", () => ({
  registerAgentMedia: m.register,
  resolveOwnedAgentMedia: m.resolve,
}));
vi.mock("./r2-storage.server", () => ({ getMediaBucket: () => ({ head: m.head }) }));
import {
  searchStockPhotos,
  importStockPhoto,
  availableStockProviders,
} from "./scheduler-stock.server";
function photo(id: number, licence = "Public domain", domain = "upload.wikimedia.org") {
  return {
    pageid: id,
    title: "File:Coffee.jpg",
    imageinfo: [
      {
        thumburl: `https://${domain}/wikipedia/commons/coffee.jpg`,
        descriptionurl: `https://commons.wikimedia.org/wiki/File:Coffee.jpg`,
        mime: "image/jpeg",
        extmetadata: {
          LicenseShortName: { value: licence },
          Copyrighted: { value: licence === "Public domain" ? "False" : "True" },
          Artist: { value: "<a>A photographer</a>" },
        },
      },
    ],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PEXELS_API_KEY", "");
  vi.stubEnv("PIXABAY_API_KEY", "");
  vi.stubGlobal("fetch", m.fetch);
  m.register.mockResolvedValue("media");
  m.resolve.mockResolvedValue([{ key: "owned", url: "https://bento.surf/owned.jpg" }]);
});

const pixabayHit = (id = 42) => ({
  id,
  type: "photo",
  pageURL: `https://pixabay.com/photos/coffee-${id}/`,
  user: "Photographer",
  user_id: 7,
  tags: "coffee, desk",
  previewURL: "https://cdn.pixabay.com/photo/coffee_150.jpg",
  largeImageURL: "https://pixabay.com/get/coffee_1280.jpg",
});

it("offers only configured providers, preferring Pixabay and keeping Commons available", () => {
  expect(availableStockProviders()).toEqual(["commons"]);
  vi.stubEnv("PEXELS_API_KEY", "pexels-key");
  expect(availableStockProviders()).toEqual(["pexels", "commons"]);
  vi.stubEnv("PIXABAY_API_KEY", "pixabay-private-key");
  expect(availableStockProviders()).toEqual(["pixabay", "pexels", "commons"]);
});

it("caches bounded safe Pixabay results for 24 hours without putting credentials in the cache or result", async () => {
  vi.stubEnv("PIXABAY_API_KEY", "pixabay-private-key");
  const stored = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: string) => stored.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => {
      stored.set(key, response);
    }),
  };
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  m.fetch.mockResolvedValue(
    Response.json({
      hits: [pixabayHit(), { ...pixabayHit(43), largeImageURL: "https://127.0.0.1/private.jpg" }],
    }),
  );
  const result = await searchStockPhotos("COFFEE", 2);
  expect(result).toEqual([
    expect.objectContaining({ provider: "pixabay", id: 42, photographer: "Photographer" }),
  ]);
  expect(JSON.stringify(result)).not.toContain("pixabay-private-key");
  const url = new URL(m.fetch.mock.calls[0][0]);
  expect(url.origin + url.pathname).toBe("https://pixabay.com/api/");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    q: "coffee",
    page: "2",
    per_page: "12",
    image_type: "photo",
    safesearch: "true",
    key: "pixabay-private-key",
  });
  expect(m.fetch.mock.calls[0][1].redirect).toBe("manual");
  expect(m.limit).toHaveBeenCalledWith("EXPENSIVE_API_RATE_LIMITER", "pixabay-shared", "pixabay");
  expect(cache.put.mock.calls[0][0]).not.toContain("pixabay-private-key");
  expect(cache.put.mock.calls[0][1].headers.get("cache-control")).toBe("public, max-age=86400");
  expect(await searchStockPhotos("coffee", 2)).toEqual(result);
  expect(m.fetch).toHaveBeenCalledTimes(1);
  expect(m.limit).toHaveBeenCalledTimes(1);
});

it("stops without a provider call when Pixabay is unconfigured or the request cap is exhausted", async () => {
  await expect(searchStockPhotos("coffee", 1, "pixabay")).rejects.toThrow("not connected");
  vi.stubEnv("PIXABAY_API_KEY", "pixabay-private-key");
  m.limit.mockRejectedValue(new Error("Too many requests"));
  await expect(searchStockPhotos("coffee", 1, "pixabay")).rejects.toThrow("Too many requests");
  expect(m.fetch).not.toHaveBeenCalled();
});

it("does not expose Pixabay credentials or retry after network errors, invalid responses or rate limits", async () => {
  vi.stubEnv("PIXABAY_API_KEY", "pixabay-private-key");
  m.fetch.mockRejectedValueOnce(
    new Error("Failed at https://pixabay.com/api/?key=pixabay-private-key"),
  );
  await expect(searchStockPhotos("coffee", 1)).rejects.toThrow(
    "Pixabay is temporarily unavailable",
  );
  m.fetch.mockResolvedValueOnce(new Response("key=pixabay-private-key", { status: 429 }));
  await expect(searchStockPhotos("coffee", 1)).rejects.toThrow("free search limit");
  m.fetch.mockResolvedValueOnce(new Response("key=pixabay-private-key"));
  await expect(searchStockPhotos("coffee", 1)).rejects.toThrow("invalid response");
  expect(m.fetch).toHaveBeenCalledTimes(3);
});

it("imports the selected Pixabay image into owned storage and reuses it on the next selection", async () => {
  vi.stubEnv("PIXABAY_API_KEY", "pixabay-private-key");
  m.fetch
    .mockResolvedValueOnce(Response.json({ hits: [pixabayHit()] }))
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://cdn.pixabay.com/photo/coffee.jpg" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: { "content-type": "image/jpeg" },
      }),
    );
  await importStockPhoto("owner", 42, "pixabay");
  expect(new URL(m.fetch.mock.calls[0][0]).searchParams.get("id")).toBe("42");
  expect(m.store).toHaveBeenCalledWith(
    "owner",
    expect.stringContaining("users/owner/content-agent-images/"),
    expect.any(Uint8Array),
  );
  expect(m.register).toHaveBeenCalledWith(
    "owner",
    expect.any(String),
    "stock",
    expect.objectContaining({ cardId: "pixabay:42" }),
  );
  const key = m.store.mock.calls[0][1];
  m.head.mockResolvedValue({ size: 100 });
  m.fetch.mockResolvedValueOnce(Response.json({ hits: [pixabayHit()] }));
  await importStockPhoto("owner", 42, "pixabay");
  expect(m.head).toHaveBeenLastCalledWith(key);
  expect(m.store).toHaveBeenCalledTimes(1);
  expect(m.fetch).toHaveBeenCalledTimes(4);
});

it("rejects a different photo and foreign download redirects from Pixabay", async () => {
  vi.stubEnv("PIXABAY_API_KEY", "pixabay-private-key");
  m.fetch.mockResolvedValueOnce(Response.json({ hits: [pixabayHit(43)] }));
  await expect(importStockPhoto("owner", 42, "pixabay")).rejects.toThrow("no longer available");
  m.fetch.mockResolvedValueOnce(Response.json({ hits: [pixabayHit()] })).mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: "https://pixabay.com:8443/get/private.jpg" },
    }),
  );
  await expect(importStockPhoto("owner", 42, "pixabay")).rejects.toThrow();
  expect(m.fetch).toHaveBeenCalledTimes(3);
  expect(m.store).not.toHaveBeenCalled();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("uses a bounded free Commons search without credentials and filters restricted licences and hosts", async () => {
  m.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        query: {
          pages: {
            1: photo(1),
            2: photo(2, "CC BY-SA 4.0"),
            3: photo(3, "Public domain", "127.0.0.1"),
          },
        },
      }),
    ),
  );
  const result = await searchStockPhotos("coffee", 2);
  expect(result).toEqual([
    expect.objectContaining({ provider: "commons", id: 1, photographer: "A photographer" }),
  ]);
  const url = new URL(m.fetch.mock.calls[0][0]);
  expect(url.hostname).toBe("commons.wikimedia.org");
  expect(url.searchParams.get("gsrlimit")).toBe("40");
  expect(url.searchParams.get("gsroffset")).toBe("40");
  expect(m.fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  expect(m.fetch.mock.calls[0][1].redirect).toBe("manual");
});
it("rechecks the source licence when a photo is selected", async () => {
  m.fetch.mockResolvedValue(
    new Response(JSON.stringify({ query: { pages: { 1: photo(1, "CC BY-SA 4.0") } } })),
  );
  await expect(importStockPhoto("owner", 1, "commons")).rejects.toThrow("licence changed");
  expect(m.store).not.toHaveBeenCalled();
  expect(m.fetch).toHaveBeenCalledTimes(1);
});

it("accepts Commons' thumbnail host and explicit CC0 waiver with Copyrighted=True", async () => {
  const cc0 = photo(7, "CC0", "thumb.wikimedia.org");
  Object.assign(cc0.imageinfo[0].extmetadata, {
    LicenseUrl: { value: "http://creativecommons.org/publicdomain/zero/1.0/deed.en" },
  });
  m.fetch.mockResolvedValue(Response.json({ query: { pages: { 7: cc0 } } }));
  expect(await searchStockPhotos("coffee", 1)).toEqual([
    expect.objectContaining({ id: 7, provider: "commons" }),
  ]);
});

it("identifies image downloads and rejects redirects away from the stock provider", async () => {
  m.fetch.mockResolvedValueOnce(Response.json({ query: { pages: { 1: photo(1) } } }));
  m.fetch.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: "https://example.com/untrusted.jpg" } }),
  );
  await expect(importStockPhoto("owner", 1, "commons")).rejects.toThrow();
  expect(m.fetch).toHaveBeenCalledTimes(2);
  expect(m.fetch.mock.calls[1][1]).toMatchObject({
    redirect: "manual",
    headers: { "User-Agent": expect.stringContaining("BentoSurf/") },
  });
  expect(m.store).not.toHaveBeenCalled();
});
it("does not download or transform an already imported photo again", async () => {
  m.fetch.mockImplementation(
    async () => new Response(JSON.stringify({ query: { pages: { 1: photo(1) } } })),
  );
  m.head.mockResolvedValue({ size: 100 });
  await importStockPhoto("owner", 1, "commons");
  expect(m.fetch).toHaveBeenCalledTimes(1);
  expect(m.store).not.toHaveBeenCalled();
  expect(m.register).toHaveBeenCalledWith(
    "owner",
    expect.stringContaining("users/owner/content-agent-images/"),
    "stock",
    expect.objectContaining({ cardId: "commons:1" }),
  );
});
it("stops an import if the shared storage/transformation budget rejects it", async () => {
  m.fetch
    .mockResolvedValueOnce(new Response(JSON.stringify({ query: { pages: { 1: photo(1) } } })))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([255, 216, 255, 217]), {
        headers: { "content-type": "image/jpeg" },
      }),
    );
  m.store.mockRejectedValue(new Error("Budget reached"));
  await expect(importStockPhoto("owner", 1, "commons")).rejects.toThrow("Budget reached");
  expect(m.register).not.toHaveBeenCalled();
});
