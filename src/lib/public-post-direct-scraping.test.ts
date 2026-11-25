import { describe, expect, it, vi } from "vitest";
import { publicPostCountEvidence } from "./content-source-enrichment";
import { instagramPostFromUrl, parseInstagramEmbedStats } from "./instagram-embed";
import { normalizePublicPostUrl } from "./public-post-stats";
import { discoverPostKey } from "./content-discover-identity";
import { readPublicPostStats } from "./public-post-stats.server";

const url = "https://www.instagram.com/reel/ExactPost/";
const script = (data: unknown) =>
  `<script type="application/json">${JSON.stringify(data)}</script>`;

describe("direct Instagram counter scraping", () => {
  it("labels a platform login gate without guessing a public zero", async () => {
    const result = await readPublicPostStats(url, {
      cache: null,
      env: {},
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("<title>Post</title>", { headers: { "content-type": "text/html" } }),
        ),
      rendered: async () => ({
        value: script({ code: "ExactPost", like_count: 145, comment_count: 192 }),
        requiresSignIn: ["shares", "reposts"],
      }),
    });
    expect(result.metrics.find((m) => m.key === "shares")).toMatchObject({
      value: null,
      availability: "requires_sign_in",
    });
    expect(result.metrics.find((m) => m.key === "reposts")).toMatchObject({
      value: null,
      availability: "requires_sign_in",
    });
    expect(result.metrics.find((m) => m.key === "likes")?.value).toBe(145);
  });
  it("accepts Instagram URLs copied from a creator profile, with the same post identity", () => {
    const link = "https://www.instagram.com/creator.name/reel/ExactPost/?igsh=tracking";
    expect(normalizePublicPostUrl(link)).toMatchObject({
      platform: "Instagram",
      url: "https://instagram.com/reel/ExactPost",
    });
    expect(instagramPostFromUrl(link)?.shortcode).toBe("ExactPost");
    expect(discoverPostKey({ sourceUrl: link })).toBe("instagram:ExactPost");
  });
  it("reads the field names used by the live Instagram page for this exact Reel", () => {
    expect(
      publicPostCountEvidence(
        script({
          code: "ExactPost",
          like_count: 145,
          comment_count: 192,
          reshare_count: 88,
          media_repost_count: 8,
          view_count: 2100,
        }),
        url,
      ),
    ).toEqual({ likes: 145, comments: 192, shares: 88, reposts: 8, views: 2100 });
  });
  it("reads deeply streamed Relay data without accepting a recommended Reel's counts", () => {
    let data: unknown = {
      items: [
        { code: "OtherPost", reshare_count: 9999, media_repost_count: 8888 },
        {
          code: "ExactPost",
          like_count: 145,
          comment_count: 192,
          reshare_count: 88,
          media_repost_count: 8,
        },
      ],
    };
    for (let i = 0; i < 18; i++) data = { stream: data };
    expect(publicPostCountEvidence(script(data), url)).toEqual({
      likes: 145,
      comments: 192,
      shares: 88,
      reposts: 8,
    });
  });
  it("does not publish disabled counts or a private account's media", () => {
    expect(
      publicPostCountEvidence(
        script({
          code: "ExactPost",
          like_count: 0,
          view_count: 0,
          reshare_count: 0,
          like_and_view_counts_disabled: true,
          share_count_disabled: true,
          comment_count: 3,
        }),
        url,
      ),
    ).toEqual({ comments: 3 });
    expect(
      publicPostCountEvidence(
        script({ code: "ExactPost", like_count: 10, reshare_count: 4, user: { is_private: true } }),
        url,
      ),
    ).toEqual({});
  });
  it("accepts the current repost field in the existing downloader embed", () => {
    const context = {
      gql_data: {
        shortcode_media: {
          shortcode: "ExactPost",
          owner: { is_private: false },
          media_repost_count: 8,
          reshare_count: 88,
        },
      },
    };
    const html = JSON.stringify({ contextJSON: JSON.stringify(context) });
    expect(parseInstagramEmbedStats(html, instagramPostFromUrl(url)!)).toEqual({
      reposts: 8,
      shares: 88,
    });
  });
  it("reads Facebook's streamed Reel feedback while excluding another video's feedback", () => {
    const blocks = Array.from({ length: 90 }, () => script({ bootstrap: true })).join("");
    const item = (id: string, n: number) => ({
      video: { id },
      attachments: [{ media: { id } }],
      feedback: { total_comment_count: n, share_count_reduced: String(n + 1) },
      fb_reel_react_button: { story: { feedback: { unified_reactors: { count: n + 2 } } } },
    });
    expect(
      publicPostCountEvidence(
        blocks + script([item("999", 9000), item("12345", 121)]),
        "https://facebook.com/reel/12345",
      ),
    ).toEqual({ likes: 123, comments: 121, shares: 122 });
  });
});
