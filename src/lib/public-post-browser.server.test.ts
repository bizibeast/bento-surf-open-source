import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ launch: vi.fn(), budget: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: mocks.launch } }));
vi.mock("./social-preview-reliability.server", () => ({
  withPublicPostBrowserBudget: mocks.budget,
}));
import { readRenderedPublicPostStats } from "./public-post-browser.server";

const source = "https://instagram.com/reel/ExactPost";
let page: {
  goto: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  setUserAgent: ReturnType<typeof vi.fn>;
  setExtraHTTPHeaders: ReturnType<typeof vi.fn>;
  setRequestInterception: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  waitForFunction: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
};
let browser: {
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.resetAllMocks();
  const packet = {
    value:
      '<script type="application/json">{"code":"ExactPost","reshare_count":88,"media_repost_count":8}</script>',
    visibleCounts: {},
    canonicalUrl: "https://www.instagram.com/p/ExactPost/",
    ready: true,
  };
  page = {
    goto: vi.fn().mockResolvedValue({}),
    url: vi.fn().mockReturnValue("https://www.instagram.com/p/ExactPost/"),
    setUserAgent: vi.fn(),
    setExtraHTTPHeaders: vi.fn(),
    setRequestInterception: vi.fn(),
    on: vi.fn(),
    waitForFunction: vi.fn().mockResolvedValue({ jsonValue: async () => packet, dispose: vi.fn() }),
    evaluate: vi.fn().mockResolvedValue(packet),
  };
  browser = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  };
  mocks.launch.mockResolvedValue(browser);
  mocks.budget.mockImplementation(async (work) => (await work({ fetch: vi.fn() })).value);
});

describe("our direct browser scraper", () => {
  it("does not launch a browser when its existing budget is denied", async () => {
    mocks.budget.mockRejectedValue(new Error("Denied"));
    await expect(readRenderedPublicPostStats(source, ["shares"])).rejects.toThrow("Denied");
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("waits for target counter data, uses the post page, and closes its anonymous session", async () => {
    expect(await readRenderedPublicPostStats(source, ["shares", "reposts"])).toMatchObject({
      counts: { shares: 88, reposts: 8 },
    });
    expect(String(page.goto.mock.calls[0][0])).toBe("https://www.instagram.com/p/ExactPost/");
    expect(page.waitForFunction).toHaveBeenCalledOnce();
    expect(mocks.launch.mock.calls[0][1]).toMatchObject({ keep_alive: 10000 });
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("rejects a redirect or canonical identity mismatch even when counts are present", async () => {
    page.url.mockReturnValue("https://www.instagram.com/reel/OtherPost/");
    await expect(readRenderedPublicPostStats(source, ["shares"])).rejects.toThrow(/identity/i);
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("closes the session when navigation or counter loading fails", async () => {
    page.goto.mockRejectedValue(new Error("Navigation failed"));
    await expect(readRenderedPublicPostStats(source, ["shares"])).rejects.toThrow(
      "Navigation failed",
    );
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("tries the Reel surface within the same signed-out visitor session when the preview omits requested counters", async () => {
    const preview = {
      value:
        '<script type="application/json">{"code":"ExactPost","like_count":145,"comment_count":192}</script>',
      visibleCounts: {},
      canonicalUrl: "https://instagram.com/p/ExactPost",
      ready: true,
    };
    const full = {
      ...preview,
      value:
        '<script type="application/json">{"code":"ExactPost","reshare_count":88,"media_repost_count":8}</script>',
    };
    page.url.mockImplementation(() => page.goto.mock.calls.at(-1)![0]);
    page.waitForFunction
      .mockResolvedValueOnce({ jsonValue: async () => preview, dispose: vi.fn() })
      .mockResolvedValueOnce({ jsonValue: async () => full, dispose: vi.fn() });
    expect(await readRenderedPublicPostStats(source, ["shares", "reposts"])).toMatchObject({
      counts: { likes: 145, comments: 192, shares: 88, reposts: 8 },
    });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(String(page.goto.mock.calls[1][0])).toBe("https://www.instagram.com/reels/ExactPost/");
    expect(mocks.launch).toHaveBeenCalledOnce();
  });
  it("keeps the public preview if the signed-out Reel surface is gated", async () => {
    const preview = {
      value:
        '<script type="application/json">{"code":"ExactPost","like_count":145,"comment_count":192}</script>',
      visibleCounts: {},
      canonicalUrl: "https://instagram.com/p/ExactPost",
      ready: true,
    };
    page.waitForFunction.mockResolvedValueOnce({
      jsonValue: async () => preview,
      dispose: vi.fn(),
    });
    page.goto
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Guest navigation blocked"));
    expect(await readRenderedPublicPostStats(source, ["shares"])).toMatchObject({
      counts: { likes: 145, comments: 192 },
    });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledOnce();
  });
  it("blocks private destinations and media downloads before a browser request runs", async () => {
    await readRenderedPublicPostStats(source, ["shares"]);
    const handler = page.on.mock.calls.find(([event]) => event === "request")![1];
    for (const url of [
      "https://127.0.0.1/private",
      "https://metadata.google.internal/",
      "https://example.org/collect",
    ]) {
      const abort = vi.fn(),
        proceed = vi.fn();
      await handler({
        url: () => url,
        resourceType: () => "xhr",
        isNavigationRequest: () => false,
        abort,
        continue: proceed,
      });
      expect(abort).toHaveBeenCalledOnce();
      expect(proceed).not.toHaveBeenCalled();
    }
    const abort = vi.fn();
    await handler({
      url: () => "https://scontent.cdninstagram.com/video.mp4",
      resourceType: () => "media",
      isNavigationRequest: () => false,
      abort,
      continue: vi.fn(),
    });
    expect(abort).toHaveBeenCalledOnce();
    const fetchAbort = vi.fn();
    await handler({
      url: () => "https://scontent.cdninstagram.com/video.mp4?public=1",
      resourceType: () => "fetch",
      isNavigationRequest: () => false,
      abort: fetchAbort,
      continue: vi.fn(),
    });
    expect(fetchAbort).toHaveBeenCalledOnce();
  });
});
