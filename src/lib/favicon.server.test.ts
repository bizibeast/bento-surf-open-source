import { afterEach, expect, it, vi } from "vitest";
import { handleFaviconRequest } from "./favicon.server";
afterEach(() => vi.unstubAllGlobals());
it("only serves bounded raster icons from the fixed provider", async () => {
  const fetch = vi.fn(
    async (_input: string | URL) =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await handleFaviconRequest(
    new Request("http://localhost:8080/api/favicon?domain=example.com"),
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("content-type")).toBe("image/png");
  expect(String(fetch.mock.calls[0][0])).toContain("https://t0.gstatic.com/faviconV2");
});
it("rejects arbitrary URLs and off-provider redirects", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    (
      await handleFaviconRequest(
        new Request("http://localhost:8080/api/favicon?domain=http://private"),
      )
    ).status,
  ).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (
      await handleFaviconRequest(
        new Request("http://localhost:8080/api/favicon?domain=example.com"),
      )
    ).status,
  ).toBe(404);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("falls back to the second fixed CDN when the first is unavailable", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/x-icon" } }),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await handleFaviconRequest(
    new Request("http://localhost:8080/api/favicon?domain=github.com"),
  );
  expect(result.status).toBe(200);
  expect(fetch.mock.calls[1][0]).toBe("https://icons.duckduckgo.com/ip3/github.com.ico");
});
