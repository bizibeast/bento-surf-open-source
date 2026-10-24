import { describe, expect, it, vi } from "vitest";
import {
  enrichContentSources,
  publicCreatorMetadata,
  publicPostMetadata,
} from "./content-source-enrichment.server";
import { sourcePostEmbed, sourcePresentation, sourceThumbnail } from "./content-source-media";

const post = {
  canonicalUrl: "https://www.instagram.com/reel/Abcdef123/",
  title: "Search snippet",
  summary: "",
  sourceName: "Instagram",
  platform: "Instagram",
  kind: "social_search" as const,
  publishedAt: null,
  retrievedAt: "2026-10-06T00:00:00Z",
};
const instagramHtml = `<meta property="og:title" content="A Creator on Instagram: &quot;A real post&quot;"><meta content="https://scontent.cdninstagram.com/reel.jpg?a=1&amp;b=2" property="og:image"><meta property="og:description" content="12 likes, 2 comments - creator on October 5, 2026: &quot;A real post.&#10;With the whole caption.&quot;.">`;

describe("Discover media enrichment", () => {
  it("extracts a reel cover, caption, attribution and only Instagram's observed engagement", () => {
    const result = publicPostMetadata(instagramHtml, post.canonicalUrl);
    expect(result).toMatchObject({
      title: "A real post.",
      summary: "A real post.\nWith the whole caption.",
      author: "A Creator",
      authorUrl: "https://www.instagram.com/creator/",
      thumbnailUrl: "https://scontent.cdninstagram.com/reel.jpg?a=1&b=2",
      mediaType: "video",
      publishedAt: "2026-10-05T00:00:00.000Z",
      stats: { likes: 12, comments: 2 },
    });
    expect(result.stats).not.toHaveProperty("views");
  });
  it("preserves structured carousel media and the author's actual photo", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "SocialMediaPosting", articleBody: "Full post", author: { "@type": "Person", name: "Creator", url: "https://example.com/creator", image: "https://example.com/avatar.jpg" }, image: ["https://example.com/1.jpg", "https://example.com/2.jpg"] })}</script>`;
    const result = publicPostMetadata(html, "https://example.com/post");
    expect(result).toMatchObject({
      author: "Creator",
      authorAvatarUrl: "https://example.com/avatar.jpg",
      mediaType: "carousel",
    });
    expect(result.media).toHaveLength(2);
  });
  it("uses oEmbed and shares one creator photo request across their posts", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/oembed"))
        return Response.json({
          title: "Video title",
          author_name: "Creator",
          author_url: "https://www.youtube.com/@creator",
          thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
          type: "video",
        });
      return new Response('<meta property="og:image" content="https://yt3.ggpht.com/photo.jpg">');
    });
    const result = await enrichContentSources(
      [1, 2].map((i) => ({
        ...post,
        canonicalUrl: `https://www.youtube.com/watch?v=${i === 1 ? "dQw4w9WgXcQ" : "r0c7RhMFcww"}`,
        platform: "YouTube",
      })),
      { fetcher },
    );
    expect(result.every((item) => item.authorAvatarUrl === "https://yt3.ggpht.com/photo.jpg")).toBe(
      true,
    );
    expect(
      fetcher.mock.calls.filter(([url]) => String(url) === "https://www.youtube.com/@creator"),
    ).toHaveLength(1);
  });
  it("keeps posts and source links when metadata fails, and refuses unsafe redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
      );
    const [result] = await enrichContentSources([post], { fetcher });
    expect(result.canonicalUrl).toBe(post.canonicalUrl);
    expect(result.title).toBe(post.title);
    expect(
      fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname === "www.instagram.com"),
    ).toBe(true);
    expect(
      publicPostMetadata(
        '<meta property="og:title" content="Log in to Instagram"><meta property="og:image" content="https://example.com/logo.png">',
        post.canonicalUrl,
      ),
    ).toEqual({});
  });
  it("never embeds arbitrary source HTML or unsafe media URLs", () => {
    expect(
      sourcePresentation({
        authorAvatarUrl: "javascript:alert(1)",
        media: [{ type: "image", url: "https://127.0.0.1/secret" }],
      }),
    ).toMatchObject({ authorAvatarUrl: null, media: [] });
    for (const source of [
      "https://instagram.com.attacker.example/reel/Abcdef123/",
      "https://user:pass@instagram.com/reel/Abcdef123/",
      "http://instagram.com/reel/Abcdef123/",
    ])
      expect(sourcePostEmbed(source)).toBeNull();
    expect(sourcePostEmbed(post.canonicalUrl)?.url).toBe(
      "https://www.instagram.com/reel/Abcdef123/embed/",
    );
    expect(
      sourcePostEmbed("https://www.tiktok.com/@creator/video/1234567890123456789")?.url,
    ).toContain("/player/v1/1234567890123456789");
    expect(sourceThumbnail({ sourceUrl: "https://youtu.be/dQw4w9WgXcQ" })).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
  });
});

it("reads the post creator's image from LinkedIn's creator field, not a comment author", () => {
  const creator = {
    name: "The AI Mastery Hub",
    url: "https://www.linkedin.com/company/the-ai-mastery-hub",
    image: { url: "https://media.licdn.com/creator.jpg" },
  };
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "VideoObject", creator, comment: [{ creator: { name: "A commenter", image: "https://media.licdn.com/commenter.jpg" } }], thumbnailUrl: "https://media.licdn.com/cover.jpg" })}</script>`;
  expect(
    publicPostMetadata(
      html,
      "https://www.linkedin.com/posts/the-ai-mastery-hub_activity-1234567890-abcd",
    ),
  ).toMatchObject({
    author: creator.name,
    authorUrl: creator.url,
    authorAvatarUrl: creator.image.url,
  });
});

it("recovers Instagram's actual owner picture from the public post embed when profile pages have no photo", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/embed/"))
      return new Response(
        '<div class="Header"><a class="Avatar" href="https://www.instagram.com/creator/?utm_source=ig_embed"><img src="https://scontent.cdninstagram.com/owner.jpg?a=1&amp;b=2" /></a></div>',
      );
    return new Response(instagramHtml);
  });
  const [result] = await enrichContentSources([post], { fetcher });
  expect(result.authorAvatarUrl).toBe("https://scontent.cdninstagram.com/owner.jpg?a=1&b=2");
  expect(result.authorAvatarUrl).not.toBe(result.thumbnailUrl);
  expect(result.authorUrl).toBe("https://www.instagram.com/creator/");
});

it("recognizes an Instagram creator's avatar when their active story changes the profile link", () => {
  const html =
    '<div class="Header"><a class="Avatar InsideRing" href="https://www.instagram.com/stories/bran_reluao/?utm_source=ig_embed"><img src="https://scontent.cdninstagram.com/owner.jpg" alt="bran_reluao"></a></div>';
  expect(publicPostMetadata(html, "https://www.instagram.com/reel/DWBMr6tiVTV/")).toMatchObject({
    authorUrl: "https://www.instagram.com/bran_reluao/",
    authorAvatarUrl: "https://scontent.cdninstagram.com/owner.jpg",
  });
});

it("selects the requested creator's photo from an Instagram collaboration post", () => {
  const html =
    '<div class="AvatarContainer"><a class="CollabAvatar" href="https://www.instagram.com/publisher/" data-ios-link="user?username=research"><img src="https://scontent.cdninstagram.com/publisher.jpg"></a><a class="CollabAvatar SecondCollabAvatar" href="https://www.instagram.com/research/"><img src="https://scontent.cdninstagram.com/research.jpg"></a></div>';
  expect(
    publicPostMetadata(
      html,
      "https://www.instagram.com/p/Abcdef123/",
      "https://www.instagram.com/research/",
    ),
  ).toMatchObject({
    authorUrl: "https://www.instagram.com/research/",
    authorAvatarUrl: "https://scontent.cdninstagram.com/research.jpg",
  });
  expect(publicPostMetadata(html, "https://www.instagram.com/p/Abcdef123/")).toMatchObject({
    authorUrl: "https://www.instagram.com/research/",
    authorAvatarUrl: "https://scontent.cdninstagram.com/research.jpg",
  });
});

const jsonLd = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const youtubePlayer = (id = "dQw4w9WgXcQ") =>
  `<script nonce="provider-nonce">var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: {
      videoId: id,
      title: 'A video about {culture} and "creativity"',
      viewCount: "250123",
    },
    microformat: {
      playerMicroformatRenderer: { publishDate: "2026-10-05", uploadDate: "2026-10-04" },
    },
  })}; window.unrelated = {viewCount: "900000000"};</script>`;

it("keeps a post's interactions separate from its creator's observed audience", () => {
  const result = publicPostMetadata(
    jsonLd({
      "@context": "https://schema.org",
      "@type": "VideoObject",
      uploadDate: "2026-10-05T09:30:00Z",
      dateModified: "2026-10-06T09:30:00Z",
      thumbnailUrl: "https://media.licdn.com/cover.jpg",
      interactionStatistic: [
        {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/WatchAction",
          userInteractionCount: "240,123",
        },
        {
          "@type": "InteractionCounter",
          interactionType: { "@type": "LikeAction" },
          userInteractionCount: 3100,
        },
        {
          "@type": "InteractionCounter",
          interactionType: { "@type": "CommentAction" },
          userInteractionCount: "35",
        },
        {
          "@type": "InteractionCounter",
          interactionType: { "@type": "ShareAction" },
          userInteractionCount: -2,
        },
      ],
      creator: {
        name: "Creator",
        interactionStatistic: { interactionType: "FollowAction", userInteractionCount: 5000000 },
      },
    }),
    "https://www.linkedin.com/posts/creator_activity-1234567890-abcd",
  );
  expect(result.publishedAt).toBe("2026-10-05T09:30:00.000Z");
  expect(result.stats).toEqual({ views: 240123, likes: 3100, comments: 35, followers: 5000000 });
});

it("does not substitute crawl, modification or future timestamps for publication", () => {
  for (const payload of [
    { dateModified: "2026-10-05T09:30:00Z" },
    { datePublished: "2099-01-01" },
    { datePublished: "yesterday", uploadDate: "not a date" },
  ]) {
    const result = publicPostMetadata(
      jsonLd({ "@type": "Article", ...payload }),
      "https://example.com/article",
    );
    expect(result.publishedAt).toBeNull();
    expect(result.stats).toBeUndefined();
  }
});

it("extracts matching YouTube player data and itemprop metadata while rejecting another video's counters", () => {
  expect(publicPostMetadata(youtubePlayer(), youtubeUrl)).toMatchObject({
    publishedAt: "2026-10-05T00:00:00.000Z",
    stats: { views: 250123 },
  });
  expect(publicPostMetadata(youtubePlayer("r0c7RhMFcww"), youtubeUrl).stats).toBeUndefined();
  expect(
    publicPostMetadata(
      '<meta itemprop="datePublished" content="2026-10-05"><meta itemprop="interactionCount" content="240123">',
      youtubeUrl,
    ),
  ).toMatchObject({
    publishedAt: "2026-10-05T00:00:00.000Z",
    stats: { views: 240123 },
  });
});

it("reads only the requested TikTok item from a hydration payload that includes recommendations", () => {
  const item = {
    id: "7550000000000000000",
    createTime: Date.parse("2026-10-05T11:00:00Z") / 1000,
    stats: {
      playCount: 1500000,
      diggCount: 50200,
      commentCount: 87,
      shareCount: 410,
      collectCount: 925,
    },
  };
  const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
    {
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": { itemInfo: { itemStruct: item } },
        recommended: { ...item, id: "7550000000000000001", stats: { playCount: 900000000 } },
      },
    },
  )}</script>`;
  expect(
    publicPostMetadata(html, `https://www.tiktok.com/@creator/video/${item.id}`),
  ).toMatchObject({
    publishedAt: "2026-10-05T11:00:00.000Z",
    stats: { views: 1500000, likes: 50200, comments: 87, shares: 410, saves: 925 },
  });
});

it("reads Instagram's matching shortcode data without interpreting caption numbers as engagement", () => {
  const html = `<script type="application/json">${JSON.stringify({
    data: {
      xdt_shortcode_media: {
        shortcode: "Abcdef123",
        taken_at_timestamp: Date.parse("2026-10-05T11:00:00Z") / 1000,
        edge_media_preview_like: { count: 14000 },
        edge_media_to_comment: { count: 125 },
        video_view_count: 125000,
        caption: "Our goal: 1,000,000 likes and 50,000 comments.",
      },
    },
  })}</script>`;
  expect(publicPostMetadata(html, post.canonicalUrl)).toMatchObject({
    publishedAt: "2026-10-05T11:00:00.000Z",
    stats: { views: 125000, likes: 14000, comments: 125 },
  });
});

it("fetches publication and performance evidence even when oEmbed succeeds", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/oembed"))
      return Response.json({
        title: "Video",
        author_name: "Creator",
        author_avatar_url: "https://example.com/avatar.jpg",
        thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        type: "video",
      });
    return new Response(youtubePlayer());
  });
  const [result] = await enrichContentSources(
    [{ ...post, canonicalUrl: youtubeUrl, platform: "YouTube" }],
    { fetcher },
  );
  expect(fetcher.mock.calls.some(([url]) => String(url) === youtubeUrl)).toBe(true);
  expect(result).toMatchObject({
    publishedAt: "2026-10-05T00:00:00.000Z",
    stats: { views: 250123 },
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    mediaType: "video",
  });
});

it("retries a transient provider failure once and retains existing carousel images and stats", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValueOnce(
      new Response(jsonLd({ "@type": "SocialMediaPosting", datePublished: "2026-10-05" })),
    );
  const source = {
    ...post,
    canonicalUrl: "https://www.linkedin.com/posts/creator_activity-1234567890-abcd",
    author: "Creator",
    authorAvatarUrl: "https://media.licdn.com/avatar.jpg",
    thumbnailUrl: "https://media.licdn.com/cover.jpg",
    mediaType: "carousel" as const,
    media: [
      { type: "image" as const, url: "https://media.licdn.com/1.jpg" },
      { type: "image" as const, url: "https://media.licdn.com/2.jpg" },
    ],
    stats: { likes: 1520 },
  };
  const [result] = await enrichContentSources([source], { fetcher });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({
    publishedAt: "2026-10-05T00:00:00.000Z",
    media: source.media,
    mediaType: "carousel",
    stats: source.stats,
  });
});

it("does not retry a permanent provider denial or discard the search result", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
  const source = {
    ...post,
    canonicalUrl: "https://www.linkedin.com/posts/creator_activity-1234567890-abcd",
  };
  const [result] = await enrichContentSources([source], { fetcher });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.title).toBe(source.title);
  expect(result.publishedAt).toBeNull();
});

it("gives all post metadata requests priority over optional avatar requests", async () => {
  const requested: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("example.com/post"))
      return new Response(
        jsonLd({
          "@type": "SocialMediaPosting",
          author: { name: "Creator", url: "https://www.youtube.com/@creator" },
          datePublished: "2026-10-05",
        }),
      );
    return new Response('<meta property="og:image" content="https://yt3.ggpht.com/avatar.jpg">');
  });
  const sources = Array.from({ length: 20 }, (_, index) => ({
    ...post,
    canonicalUrl: `https://example.com/post/${index}`,
  }));
  const result = await enrichContentSources(sources, { fetcher });
  expect(requested.slice(0, 20)).toEqual(
    expect.arrayContaining(sources.map((item) => item.canonicalUrl)),
  );
  expect(requested.filter((url) => url === "https://www.youtube.com/@creator")).toHaveLength(1);
  expect(result.every((item) => item.publishedAt && item.authorAvatarUrl)).toBe(true);
});

it("does not turn an Instagram caption's aspirational numbers into observed engagement", () => {
  const result = publicPostMetadata(
    '<meta property="og:description" content="Our goal is 1,000,000 likes and 50,000 comments.">',
    post.canonicalUrl,
  );
  expect(result.stats).toBeUndefined();
  expect(result.publishedAt).toBeNull();
});

it("stops an unresponsive provider within the shared enrichment deadline", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
      }),
  );
  const started = Date.now();
  const source = {
    ...post,
    canonicalUrl: "https://www.linkedin.com/posts/creator_activity-1234567890-abcd",
    authorAvatarUrl: "https://media.licdn.com/avatar.jpg",
  };
  const result = await enrichContentSources(
    Array.from({ length: 20 }, () => source),
    { fetcher, timeoutMs: 80 },
  );
  expect(result).toHaveLength(20);
  expect(result.every((item) => item.canonicalUrl === source.canonicalUrl)).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(fetcher).toHaveBeenCalledTimes(8);
});

it("rejects an oversized provider response without retrying it", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response("oversized", { headers: { "content-length": "9000000" } }),
  );
  const source = {
    ...post,
    canonicalUrl: "https://www.linkedin.com/posts/creator_activity-1234567890-abcd",
  };
  const [result] = await enrichContentSources([source], { fetcher });
  expect(result.title).toBe(source.title);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

const followCount = (count: unknown) => ({
  "@type": "InteractionCounter",
  interactionType: "https://schema.org/FollowAction",
  userInteractionCount: count,
});
const publicJson = (value: unknown) =>
  `<script type="application/json">${JSON.stringify(value)}</script>`;
const profileUrl = "https://www.instagram.com/creator/";

describe("Verified creator audience evidence", () => {
  it("uses the attributed JSON-LD creator and ignores commenters or a different expected owner", () => {
    const owner = "https://www.linkedin.com/in/creator";
    const html = jsonLd({
      "@type": "SocialMediaPosting",
      author: { "@type": "Person", url: owner, interactionStatistic: followCount(12500) },
      comment: [
        {
          author: {
            url: "https://www.linkedin.com/in/commenter",
            interactionStatistic: followCount(99000000),
          },
        },
      ],
    });
    expect(
      publicPostMetadata(
        html,
        "https://www.linkedin.com/posts/creator_activity-1234567890-abcd",
        owner,
      ).stats?.followers,
    ).toBe(12500);
    expect(
      publicPostMetadata(
        html,
        "https://www.linkedin.com/posts/creator_activity-1234567890-abcd",
        "https://www.linkedin.com/in/another",
      ).stats?.followers,
    ).toBeUndefined();
  });

  it("preserves an observed zero and leaves a missing audience unknown", () => {
    const html = (count?: number) =>
      publicJson({
        data: {
          xdt_shortcode_media: {
            shortcode: "Abcdef123",
            owner: {
              username: "creator",
              ...(count !== undefined ? { edge_followed_by: { count } } : {}),
            },
            like_count: 80000,
          },
        },
      });
    expect(publicPostMetadata(html(0), post.canonicalUrl, profileUrl).stats).toMatchObject({
      likes: 80000,
      followers: 0,
    });
    expect(
      publicPostMetadata(html(), post.canonicalUrl, profileUrl).stats?.followers,
    ).toBeUndefined();
    expect(
      publicPostMetadata(html(25000), post.canonicalUrl, "https://www.instagram.com/commenter/")
        .stats?.followers,
    ).toBeUndefined();
  });

  it("takes TikTok followers from the matching item's authorStats, never likes or another video", () => {
    const item = {
      id: "7550000000000000000",
      author: { uniqueId: "creator" },
      authorStats: { followerCount: 15400, heartCount: 99900000 },
      stats: { playCount: 125000, diggCount: 4200 },
    };
    const html = publicJson({
      itemInfo: { itemStruct: item },
      recommendations: [
        { ...item, id: "7550000000000000001", authorStats: { followerCount: 99900000 } },
      ],
    });
    expect(
      publicPostMetadata(html, `https://www.tiktok.com/@creator/video/${item.id}`).stats,
    ).toMatchObject({ views: 125000, likes: 4200, followers: 15400 });
  });

  it("reads X's requested tweet author while excluding quoted authors", () => {
    const html = publicJson({
      tweet: {
        rest_id: "1980000000000000000",
        core: {
          user_results: { result: { legacy: { screen_name: "creator", followers_count: 21000 } } },
        },
        quoted_status_result: {
          result: {
            rest_id: "1970000000000000000",
            core: {
              user_results: {
                result: { legacy: { screen_name: "quoted", followers_count: 99000000 } },
              },
            },
          },
        },
      },
    });
    expect(
      publicPostMetadata(html, "https://x.com/creator/status/1980000000000000000").stats?.followers,
    ).toBe(21000);
    expect(
      publicPostMetadata(html, "https://x.com/another/status/1980000000000000000").stats?.followers,
    ).toBeUndefined();
  });

  it("normalizes public profile aliases and accepts compact Instagram counts only for the canonical owner", () => {
    const html =
      '<meta property="og:url" content="https://instagram.com/Creator/"><meta property="og:description" content="12.5K followers, 612 following, 38 posts - See Instagram photos and videos from Creator (@creator)"><meta property="og:image" content="https://scontent.cdninstagram.com/avatar.jpg">';
    expect(publicCreatorMetadata(html, profileUrl)).toMatchObject({
      stats: { followers: 12500 },
      authorAvatarUrl: "https://scontent.cdninstagram.com/avatar.jpg",
    });
    expect(publicCreatorMetadata(html, "https://www.instagram.com/someoneelse/")).toEqual({});
    for (const description of [
      "1.2K likes, 50 comments",
      "1.2K following, 50 posts",
      "Our goal is 1.2K followers",
      "1.2K members, 50 posts",
    ]) {
      expect(
        publicCreatorMetadata(
          `<meta property="og:url" content="${profileUrl}"><meta property="og:description" content="${description}">`,
          profileUrl,
        ).stats,
      ).toBeUndefined();
    }
  });

  it("reads matching LinkedIn profile schema and ignores connections, employees and unrelated people", () => {
    const owner = "https://www.linkedin.com/in/creator";
    const html = jsonLd({
      "@graph": [
        {
          "@type": "Person",
          url: "https://www.linkedin.com/in/other",
          interactionStatistic: followCount(99900000),
        },
        {
          "@type": "ProfilePage",
          mainEntity: {
            "@type": "Person",
            url: owner,
            interactionStatistic: [
              followCount(4300),
              { interactionType: "LikeAction", userInteractionCount: 999999 },
            ],
          },
        },
      ],
    });
    expect(publicCreatorMetadata(html, owner).stats?.followers).toBe(4300);
    expect(
      publicCreatorMetadata(
        `<meta property="og:url" content="${owner}"><meta property="og:description" content="Creator | 500 connections on LinkedIn">`,
        owner,
      ).stats,
    ).toBeUndefined();
    expect(publicCreatorMetadata(html, "https://www.reddit.com/r/lifestyle")).toEqual({});
  });

  it("reads both direct and legacy X profile counts for the same account", () => {
    for (const owner of [
      { screen_name: "creator", followers_count: 0 },
      { legacy: { screen_name: "creator", followers_count: 0 } },
    ]) {
      const html = `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ users: { other: { screen_name: "other", followers_count: 999999 }, creator: owner } })};</script>`;
      expect(publicCreatorMetadata(html, "https://twitter.com/creator").stats?.followers).toBe(0);
    }
  });

  it("reads the matching TikTok profile user/stats pair instead of aggregate likes", () => {
    const html = publicJson({
      userInfo: {
        user: { uniqueId: "creator" },
        stats: { followerCount: 12400, heartCount: 9000000, followingCount: 100 },
      },
      suggested: { user: { uniqueId: "other" }, stats: { followerCount: 50000000 } },
    });
    expect(publicCreatorMetadata(html, "https://www.tiktok.com/@creator").stats?.followers).toBe(
      12400,
    );
  });

  it("verifies YouTube channel aliases and reads only the owning channel header", () => {
    const metadata = {
      channelMetadataRenderer: {
        externalId: "UCcreator123456",
        channelUrl: "https://www.youtube.com/channel/UCcreator123456",
        vanityChannelUrl: "https://www.youtube.com/@creator",
      },
    };
    const headers = [
      { c4TabbedHeaderRenderer: { subscriberCountText: { simpleText: "12.5K subscribers" } } },
      {
        pageHeaderRenderer: {
          content: {
            pageHeaderViewModel: {
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [
                    {
                      metadataParts: [
                        { text: { content: "1.2M views" } },
                        { text: { content: "12.5K subscribers" } },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ];
    for (const header of headers) {
      const html = `<meta property="og:url" content="https://www.youtube.com/channel/UCcreator123456"><script>var ytInitialData = ${JSON.stringify({ metadata, header, contents: { relatedChannels: [{ subscriberCountText: { simpleText: "999M subscribers" } }] } })};</script>`;
      expect(publicCreatorMetadata(html, "https://www.youtube.com/@creator").stats?.followers).toBe(
        12500,
      );
      expect(publicCreatorMetadata(html, "https://www.youtube.com/@another")).toEqual({});
    }
    const hidden = `<script>var ytInitialData = ${JSON.stringify({ metadata, contents: { subscriberCountText: { simpleText: "999M subscribers" } } })};</script>`;
    expect(publicCreatorMetadata(hidden, "https://www.youtube.com/@creator").stats).toBeUndefined();
  });

  it("shares one follower request across posts even when all avatars already exist", async () => {
    const sources = [1, 2].map((index) => ({
      ...post,
      canonicalUrl: `https://www.instagram.com/p/Post${index}/`,
      publishedAt: "2026-10-05T00:00:00Z",
      author: "Creator",
      authorUrl: index === 1 ? profileUrl : "https://instagram.com/creator",
      authorAvatarUrl: "https://scontent.cdninstagram.com/existing.jpg",
      stats: { views: 15000, likes: 125 },
    }));
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/p/")
        ? new Response("")
        : new Response(
            `<meta property="og:url" content="${profileUrl}"><meta property="og:description" content="2,345 followers, 5 following, 9 posts">`,
          ),
    );
    const results = await enrichContentSources(sources, { fetcher });
    expect(fetcher.mock.calls.filter(([input]) => !String(input).includes("/p/"))).toHaveLength(1);
    expect(
      results.every(
        (item) =>
          item.stats?.followers === 2345 &&
          item.authorAvatarUrl === "https://scontent.cdninstagram.com/existing.jpg",
      ),
    ).toBe(true);
  });

  it("refuses profile redirects to another creator and preserves unknown counts", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/p/")
        ? new Response("")
        : new Response(null, {
            status: 302,
            headers: { location: "https://www.instagram.com/someoneelse/" },
          }),
    );
    const [result] = await enrichContentSources(
      [
        {
          ...post,
          canonicalUrl: "https://www.instagram.com/p/Post1/",
          authorUrl: profileUrl,
          authorAvatarUrl: "https://scontent.cdninstagram.com/existing.jpg",
          stats: { views: 15000 },
        },
      ],
      { fetcher },
    );
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("someoneelse"))).toBe(false);
    expect(result.stats?.followers).toBeUndefined();
  });
});

it("accepts a YouTube profile redirect only when the destination proves the requested handle alias", async () => {
  for (const handle of ["creator", "someoneelse"]) {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://www.youtube.com/@creator")
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.youtube.com/channel/UCchannel123456" },
        });
      if (url.includes("/channel/"))
        return new Response(
          `<script>var ytInitialData = ${JSON.stringify({ metadata: { channelMetadataRenderer: { externalId: "UCchannel123456", vanityChannelUrl: `https://www.youtube.com/@${handle}` } }, header: { c4TabbedHeaderRenderer: { subscriberCountText: { simpleText: "25K subscribers" } } } })};</script>`,
        );
      return new Response("");
    });
    const [result] = await enrichContentSources(
      [
        {
          ...post,
          canonicalUrl: youtubeUrl,
          author: "Creator",
          authorUrl: "https://www.youtube.com/@creator",
          authorAvatarUrl: "https://yt3.ggpht.com/existing.jpg",
          stats: { views: 25000 },
        },
      ],
      { fetcher },
    );
    expect(result.stats?.followers).toBe(handle === "creator" ? 25000 : undefined);
    expect(result.authorAvatarUrl).toBe("https://yt3.ggpht.com/existing.jpg");
  }
});

it("reads only the requested X post's publication and engagement evidence", () => {
  const html = `<script type="application/json">${JSON.stringify({
    tweet: {
      rest_id: "1980000000000000000",
      legacy: {
        id_str: "1980000000000000000",
        created_at: "2026-10-22T10:00:00Z",
        favorite_count: 321,
        reply_count: 45,
        retweet_count: 67,
      },
      views: { count: "25000" },
      core: {
        user_results: { result: { legacy: { screen_name: "creator", followers_count: 21000 } } },
      },
      quoted_status_result: {
        result: {
          rest_id: "1970000000000000000",
          legacy: { favorite_count: 999999, reply_count: 99999 },
          views: { count: "99999999" },
        },
      },
    },
  })}</script>`;
  expect(
    publicPostMetadata(html, "https://x.com/creator/status/1980000000000000000"),
  ).toMatchObject({
    publishedAt: "2026-10-22T10:00:00.000Z",
    stats: { likes: 321, comments: 45, shares: 67, views: 25000, followers: 21000 },
  });
});

it("verifies missing Reddit RSS traction from the exact public post, excluding other threads", async () => {
  const source = {
    ...post,
    canonicalUrl: "https://www.reddit.com/r/startups/comments/abc123/founder/",
    platform: "Reddit",
    kind: "reddit" as const,
    title: "AI agents for a startup",
    publishedAt: "2026-10-22T09:00:00Z",
    author: "creator",
    thumbnailUrl: "https://example.com/thumbnail.jpg",
    stats: {},
  };
  const html =
    '<shreddit-post id="t3_other" score="999999" comment-count="9999"></shreddit-post><shreddit-post id="t3_abc123" score="250" comment-count="31" created-timestamp="2026-10-22T09:00:00Z"></shreddit-post>';
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(html));
  const result = await enrichContentSources([source], { fetcher });
  expect(fetcher).toHaveBeenCalledWith(source.canonicalUrl, expect.anything());
  expect(result[0].stats).toMatchObject({ likes: 250, comments: 31 });
});
