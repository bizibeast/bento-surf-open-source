import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { fetchLinkMetadataSecure } from "./link-metadata.functions";

function u32be(value: number) {
  return Uint8Array.of(
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  );
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  out.set(u32be(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function zlib(data: Uint8Array) {
  return new Uint8Array(deflateSync(data));
}

function orangePng() {
  const pixels = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) pixels.set([249, 157, 28, 255], i * 4);
  const stride = 16;
  const raw = new Uint8Array(4 * (stride + 1));
  for (let y = 0; y < 4; y++)
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(4), 0);
  ihdr.set(u32be(4), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib(raw);
  const png = new Uint8Array(8 + 25 + 12 + idat.length + 12);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  png.set(chunk("IHDR", ihdr), 8);
  png.set(chunk("IDAT", idat), 8 + 25);
  png.set(chunk("IEND", new Uint8Array()), 8 + 25 + 12 + idat.length);
  return png;
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function imageResponse(bytes: Uint8Array) {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

describe("link metadata security", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://2130706433/admin",
    "http://service.internal/admin",
  ])("does not fetch private URL %s", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await fetchLinkMetadataSecure(url, fetcher)).toEqual({
      url,
      title: url,
      favicon: null,
      color: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates every redirect before following it", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
      )
      .mockResolvedValue(imageResponse(orangePng()));
    const result = await fetchLinkMetadataSecure("https://example.com", fetcher);
    expect(result.title).toBe("example.com");
    expect(result.color).toBe("#f99d1c");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops reading oversized chunked responses", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200_001));
        controller.close();
      },
    });
    const png = orangePng();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("s2/favicons")) return imageResponse(png);
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    });
    const result = await fetchLinkMetadataSecure("https://example.com", fetcher);
    expect(result.title).toBe("example.com");
    expect(result.color).toBe("#f99d1c");
  });

  it("extracts metadata while rejecting a private favicon", async () => {
    const html =
      '<title>Safe title</title><meta name="theme-color" content="#3478f6"><link rel="icon" href="http://localhost/icon.png">';
    const png = orangePng();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("s2/favicons")) return imageResponse(png);
      return htmlResponse(html);
    });
    const result = await fetchLinkMetadataSecure("https://example.com/path", fetcher);
    expect(result.title).toBe("Safe title");
    expect(result.favicon).toContain("google.com/s2/favicons");
    expect(result.color).toBe("#f99d1c");
  });

  it("ignores unsafe values in theme-color metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("s2/favicons"))
        return new Response("not-an-image", { status: 200 });
      return htmlResponse('<meta name="theme-color" content="url(javascript:alert(1))">');
    });

    expect((await fetchLinkMetadataSecure("https://example.com", fetcher)).color).toBeNull();
  });

  it("uses the favicon majority colour instead of a white theme-color", async () => {
    const html =
      '<title>Mint</title><meta name="theme-color" content="#ffffff"><link rel="icon" href="https://www.livemint.com/icon.png">';
    const png = orangePng();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("icon.png") || String(input).includes("s2/favicons")) {
        return imageResponse(png);
      }
      return htmlResponse(html);
    });
    const result = await fetchLinkMetadataSecure("https://www.livemint.com", fetcher);
    expect(result.color).toBe("#f99d1c");
    expect(result.favicon).toBe("https://www.livemint.com/icon.png");
  });

  it("still samples Google's favicon when the page is blocked", async () => {
    const png = orangePng();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("s2/favicons")) return imageResponse(png);
      return htmlResponse("Access Denied", 403);
    });
    const result = await fetchLinkMetadataSecure("https://www.moneycontrol.com", fetcher);
    expect(result.title).toBe("moneycontrol.com");
    expect(result.color).toBe("#f99d1c");
  });
});
