import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  store: vi.fn(),
  register: vi.fn(),
  resolve: vi.fn(),
  head: vi.fn(),
}));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: vi.fn(),
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
import { searchStockPhotos, importStockPhoto } from "./scheduler-stock.server";
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
  vi.stubGlobal("fetch", m.fetch);
  m.register.mockResolvedValue("media");
  m.resolve.mockResolvedValue([{ key: "owned", url: "https://bento.surf/owned.jpg" }]);
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
