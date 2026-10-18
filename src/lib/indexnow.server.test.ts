import { afterEach, describe, expect, it, vi } from "vitest";
import {
  indexNowKeyResponse,
  indexNowUrlsForSeoArticle,
  notifyIndexNow,
  notifyPublishedSeoArticle,
  type IndexNowEnv,
} from "./indexnow.server";

const KEY = "0123456789abcdef";

function productionEnv(overrides: IndexNowEnv = {}): IndexNowEnv {
  return {
    APP_ENV: "production",
    VITE_PUBLIC_URL: "https://bento.surf",
    INDEXNOW_KEY: KEY,
    ...overrides,
  };
}

describe("IndexNow key file", () => {
  it("returns the key as plain text on the public host", async () => {
    const response = indexNowKeyResponse(
      new Request(`https://bento.surf/${KEY}.txt`),
      productionEnv(),
    );

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response?.headers.get("location")).toBeNull();
    expect(response?.headers.get("x-robots-tag")).toBeNull();
    expect(await response?.text()).toBe(KEY);
  });

  it("ignores a different path, host, or invalid key", () => {
    expect(
      indexNowKeyResponse(new Request("https://bento.surf/robots.txt"), productionEnv()),
    ).toBeNull();
    expect(
      indexNowKeyResponse(new Request(`https://app.bento.surf/${KEY}.txt`), productionEnv()),
    ).toBeNull();
    expect(
      indexNowKeyResponse(
        new Request("https://bento.surf/short.txt"),
        productionEnv({ INDEXNOW_KEY: "short" }),
      ),
    ).toBeNull();
  });
});

describe("IndexNow publication notification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("submits only the newly published blog URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));

    const result = await notifyPublishedSeoArticle(
      {
        before: { slug: "creator-website-checklist", status: "preview" },
        after: { slug: "creator-website-checklist", status: "published" },
      },
      productionEnv(),
      fetchImpl,
    );

    expect(result.submitted).toEqual([
      "https://bento.surf/blog/creator-website-checklist",
      "https://bento.surf/blog",
      "https://bento.surf/sitemaps/blog.xml",
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchImpl.mock.calls[0]!;
    expect(endpoint).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(String(init?.body))).toEqual({
      host: "bento.surf",
      key: KEY,
      keyLocation: `https://bento.surf/${KEY}.txt`,
      urlList: [
        "https://bento.surf/blog/creator-website-checklist",
        "https://bento.surf/blog",
        "https://bento.surf/sitemaps/blog.xml",
      ],
    });
  });

  it("submits the listing URLs when a published article is unpublished", () => {
    expect(
      indexNowUrlsForSeoArticle(
        "https://bento.surf",
        { slug: "creator-website-checklist", status: "published" },
        { slug: "creator-website-checklist", status: "archived" },
      ),
    ).toEqual([
      "https://bento.surf/blog/creator-website-checklist",
      "https://bento.surf/blog",
      "https://bento.surf/sitemaps/blog.xml",
    ]);
  });

  it("submits the old and new public URLs when a published slug changes", () => {
    expect(
      indexNowUrlsForSeoArticle(
        "https://bento.surf",
        { slug: "old-slug", status: "published" },
        { slug: "new-slug", status: "published" },
      ),
    ).toEqual([
      "https://bento.surf/blog/new-slug",
      "https://bento.surf/blog/old-slug",
      "https://bento.surf/blog",
      "https://bento.surf/sitemaps/blog.xml",
    ]);
  });

  it("does not notify staging or URLs on another host", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await notifyIndexNow(
      ["https://bento.surf/blog/creator-website-checklist"],
      productionEnv({ APP_ENV: "staging" }),
      fetchImpl,
    );
    const dropped = await notifyIndexNow(
      ["https://example.com/blog/other"],
      productionEnv(),
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dropped.submitted).toEqual([]);
  });

  it("leaves publication in place when IndexNow is unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      notifyPublishedSeoArticle(
        {
          before: { slug: "creator-website-checklist", status: "preview" },
          after: { slug: "creator-website-checklist", status: "published" },
        },
        productionEnv(),
        fetchImpl,
      ),
    ).resolves.toEqual({ submitted: [] });
  });
});
