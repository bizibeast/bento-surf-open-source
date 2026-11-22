import { afterEach, expect, it, vi } from "vitest";
import mediaResolver from "./media-resolver.worker";

const origin = "https://media.bento.surf";
const secret = "a-long-random-shared-secret-used-only-by-tests";
const resolver = (fetcher: typeof fetch, limit = vi.fn(async () => ({ success: true }))) => {
  vi.stubGlobal("fetch", fetcher);
  const env = { RESOLVER_SHARED_SECRET: secret, TUNNEL_RATE_LIMITER: { limit } };
  return {
    resolve: (url: string, videoQuality = "max", mediaFilter?: "video" | "image") =>
      mediaResolver
        .fetch(
          new Request(origin, {
            method: "POST",
            headers: { authorization: `Api-Key ${secret}`, "content-type": "application/json" },
            body: JSON.stringify({ url, videoQuality, downloadMode: "auto", mediaFilter }),
          }),
          env,
        )
        .then(async (response) => response.json() as Promise<PickerResponse>),
    download: (url: string | URL, init?: RequestInit) =>
      mediaResolver.fetch(new Request(url, init), env),
  };
};

type PickerResponse = {
  status: string;
  picker: { type: string; filename: string; url: string }[];
  error?: { code: string };
};

const tweetPinId = "1234567890123456789";

const jpg = Uint8Array.of(255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1);
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82);
const pdf = new TextEncoder().encode("%PDF-1.7\n%\n1 0 obj\n");
const jpgResponse = () => new Response(jpg, { headers: { "content-type": "image/jpeg" } });
const mp4Response = (seconds = 15) =>
  new Response(movieHeader(seconds), { headers: { "content-type": "video/mp4" } });
const html = (value: string) => new Response(value, { headers: { "content-type": "text/html" } });
const encoded = (value: object) =>
  JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const linkedInPost = (content: string) =>
  `<article class="main-feed-activity-card" data-activity-urn="urn:li:activity:${tweetPinId}">${content}</article>`;
const linkedInVideo = (src: string) =>
  `<video data-sources="${encoded([{ src, type: "video/mp4" }])}"></video>`;
const pinHead = (metadata: string) =>
  `<head><meta property="og:url" content="https://www.pinterest.com/pin/${tweetPinId}/">${metadata}</head>`;
const requestedPin = `https://www.pinterest.com/pin/${tweetPinId}/`;
const requestedActivity = `https://www.linkedin.com/posts/team_activity-${tweetPinId}-post`;

function movieHeader(seconds: number) {
  const bytes = new Uint8Array(60);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  bytes.set(new TextEncoder().encode("moov"), 20);
  bytes.set(new TextEncoder().encode("mvhd"), 28);
  const fields = new DataView(bytes.buffer);
  fields.setUint32(0, 16);
  fields.setUint32(16, 44);
  fields.setUint32(24, 36);
  fields.setUint32(44, 1000);
  fields.setUint32(48, seconds * 1000);
  return bytes;
}
const targetOf = (item: PickerResponse["picker"][number] | undefined) =>
  item && new URL(item.url).searchParams.get("src");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("uses the native syndication token and keeps X photos in parent order", async () => {
  const firstPhoto = "https://pbs.twimg.com/media/first.jpg";
  const secondPhoto = "https://pbs.twimg.com/media/second.jpg";
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const target = new URL(String(input));
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (target.hostname === "cdn.syndication.twimg.com") {
      expect(target.pathname).toBe("/tweet-result");
      expect(target.searchParams.get("id")).toBe(tweetPinId);
      expect(target.searchParams.get("token")).toBe("2zqic77uqyk");
      return Response.json({
        __typename: "Tweet",
        id_str: tweetPinId,
        text: "Parent with two photos",
        mediaDetails: [
          { type: "photo", media_url_https: firstPhoto },
          { type: "photo", media_url_https: secondPhoto },
        ],
        quoted_tweet: {
          mediaDetails: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/quote.jpg" },
          ],
        },
      });
    }
    return jpgResponse();
  });
  const { resolve } = resolver(fetcher);
  const result = await resolve(`https://twitter.com/i/web/status/${tweetPinId}?s=20`);
  expect(result.status).toBe("picker");
  expect(result.picker.map(targetOf)).toEqual([
    `${firstPhoto}?name=orig`,
    `${secondPhoto}?name=orig`,
  ]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("accepts a retweet resolved by X syndication to its original post", async () => {
  const photo = "https://pbs.twimg.com/media/FocH0zoWYAI6Xbo.jpg";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("tweet-result")) {
      return Response.json({
        __typename: "Tweet",
        id_str: "1623274856664948736",
        mediaDetails: [{ type: "photo", media_url_https: photo }],
      });
    }
    return jpgResponse();
  });
  const result = await resolver(fetcher).resolve(
    "https://twitter.com/liberdalau/status/1623739803874349067",
  );
  expect(result.picker.map(targetOf)).toEqual([`${photo}?name=orig`]);
});

it("uses quoted X media when the parent is empty and selects the best safe direct MP4", async () => {
  const best = "https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/best.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (new URL(String(input)).hostname === "cdn.syndication.twimg.com") {
      return Response.json({
        id_str: tweetPinId,
        mediaDetails: [],
        quoted_tweet: {
          mediaDetails: [
            {
              type: "animated_gif",
              video_info: {
                variants: [
                  {
                    content_type: "application/x-mpegURL",
                    url: "https://video.twimg.com/ext_tw_video/test.m3u8",
                  },
                  {
                    content_type: "video/mp4",
                    bitrate: 256000,
                    url: "https://video.twimg.com/ext_tw_video/low.mp4",
                  },
                  { content_type: "video/mp4", bitrate: 832000, url: best },
                  {
                    content_type: "video/mp4",
                    bitrate: 999999,
                    url: "https://video.twimg.com.evil.example/video.mp4",
                  },
                ],
              },
            },
          ],
        },
      });
    }
    expect(String(input)).toBe(best);
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(`https://x.com/example/status/${tweetPinId}`);
  expect(result.picker.map(targetOf)).toEqual([best]);
  expect(result.picker[0]).toMatchObject({
    type: "video",
    filename: expect.stringMatching(/\.mp4$/u),
  });
});

it("resolves a Pinterest short link and verifies ordered Idea pin assets using actual image signatures", async () => {
  const original = "https://i.pinimg.com/originals/ab/cd/ef/first.jpg";
  const alternate = "https://i.pinimg.com/originals/ab/cd/ef/first.png";
  const slot = "https://i.pinimg.com/736x/ab/cd/ef/slot.jpg";
  const video = "https://v1.pinimg.com/videos/mc/720p/idea.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const target = new URL(String(input));
    expect(init?.redirect).toBe("manual");
    if (target.hostname === "pin.it") {
      return Response.redirect(`https://in.pinterest.com/pin/idea-${tweetPinId}/?ref=short`);
    }
    if (target.pathname.includes("PinResource")) {
      expect(target.hostname).toBe("www.pinterest.com");
      expect(JSON.parse(target.searchParams.get("data") ?? "")).toEqual({
        options: { id: tweetPinId, field_set_key: "detailed" },
      });
      return Response.json({
        resource_response: {
          data: {
            id: tweetPinId,
            story_pin_data: {
              pages: [
                {
                  blocks: [
                    {
                      type: "image",
                      image: { images: { originals: { url: original, width: 1200 } } },
                    },
                    {
                      type: "video",
                      video: {
                        video_list: {
                          V_HLSV4: {
                            url: "https://v1.pinimg.com/videos/hls/idea.m3u8",
                            width: 9999,
                          },
                          V_EXP5: {
                            url: "https://v1.pinimg.com/videos/mc/expMp4/idea_t3.mp4",
                            width: 1280,
                            height: 720,
                          },
                          V_EXP7: { url: video, width: 1280, height: 720 },
                        },
                      },
                    },
                  ],
                },
              ],
            },
            carousel_data: { carousel_slots: [{ images: { "736x": { url: slot, width: 736 } } }] },
          },
        },
      });
    }
    if (target.href === original) {
      return new Response('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>', {
        headers: { "content-type": "image/jpeg" },
      });
    }
    if (target.href === alternate)
      return new Response(png, { headers: { "content-type": "image/jpeg" } });
    if (target.href === video) return mp4Response();
    if (target.href === slot) return jpgResponse();
    throw new Error(`unexpected fetch: ${target}`);
  });

  const result = await resolver(fetcher).resolve("https://pin.it/Idea9Pin");
  expect(result.picker.map(targetOf)).toEqual([alternate, video, slot]);
  expect(result.picker.map(({ filename }) => filename.split(".").at(-1))).toEqual([
    "png",
    "mp4",
    "jpg",
  ]);
});

it("uses the Pinterest 736x image after bogus originals and preserves the actual WebP format", async () => {
  const source = "https://i.pinimg.com/originals/ab/cd/ef/photo.jpg";
  const target = "https://i.pinimg.com/736x/ab/cd/ef/photo.jpg";
  const webp = Uint8Array.of(82, 73, 70, 70, 195, 169, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32);
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("PinResource"))
      return Response.json({ resource_response: { data: { images: { orig: { url: source } } } } });
    if (String(input) === target) return new Response(webp);
    return new Response("<Error>Access denied</Error>", {
      headers: { "content-type": "application/xml" },
    });
  });
  const result = await resolver(fetcher).resolve(
    `https://www.pinterest.com/pin/spa-experience--${tweetPinId}/sent/?ref=short`,
  );
  expect(result.picker.map(targetOf)).toEqual([target]);
  expect(result.picker[0].filename).toMatch(/\.webp$/u);
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it("uses the Pinterest pin page when detailed JSON has no media", async () => {
  const photo = "https://i.pinimg.com/736x/ab/cd/ef/fallback.jpg";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    if (target.pathname.includes("PinResource")) return Response.json({ resource_response: {} });
    if (target.hostname === "www.pinterest.com")
      return html(pinHead(`<meta content='${photo}' property='og:image'>`));
    return jpgResponse();
  });
  const result = await resolver(fetcher).resolve(`https://pinterest.com/pin/${tweetPinId}/`);
  expect(result.picker.map(targetOf)).toEqual([photo]);
});

it("uses only the requested Pinterest pin metadata when the page preloads other pins", async () => {
  const requestedVideo = "https://v1.pinimg.com/videos/mc/360p/requested.mp4";
  const recommendation = "https://v1.pinimg.com/videos/mc/1080p/recommendation.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("PinResource")) {
      return Response.json({
        resource_response: {
          data: {
            id: "1234567890123456790",
            videos: { video_list: { V_1080P: { url: recommendation } } },
          },
        },
      });
    }
    if (target === requestedPin) {
      return html(`<html>${pinHead(`<meta property="og:video" content="${requestedVideo}">`)}
        <body><script type="application/json">{"recommendations":[{"id":"1234567890123456790","url":"${recommendation}"}]}</script></body></html>`);
    }
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedPin);
  expect(result.picker?.map(targetOf)).toEqual([requestedVideo]);
  expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(recommendation);
});

it("uses the primary Pinterest VideoObject from a pin page with only an Open Graph poster", async () => {
  const video = "https://v1.pinimg.com/videos/mc/720p/12/83/f0/primary.mp4";
  const poster = "https://i.pinimg.com/736x/12/83/f0/poster.jpg";
  const unrelatedVideo = "https://v1.pinimg.com/videos/mc/1080p/another-pin.mp4";
  const untrustedVideo = "https://v1.pinimg.com.evil.example/videos/mc/1080p/primary.mp4";
  const videoObject = (id: string, contentUrl: string) =>
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "VideoObject",
      "@id": id,
      contentUrl,
      thumbnailUrl: poster,
      duration: "PT57S",
      width: "1080 px",
      height: "1920 px",
    })}</script>`;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("PinResource")) return new Response(null, { status: 502 });
    if (target === requestedPin) {
      return html(`<html><head><title>Public video</title></head>
        <body>
          <meta content="${requestedPin}" data-app="true" name="og:url" property="og:url">
          <meta content="${poster}" data-app="true" name="og:image" property="og:image">
          <link href="${requestedPin}" rel="canonical">
          <meta property="og:video" content="${unrelatedVideo}">
          ${videoObject("https://www.pinterest.com/pin/1234567890123456790/", unrelatedVideo)}
          ${videoObject(requestedPin, untrustedVideo)}
          ${videoObject(requestedPin, video)}
        </body></html>`);
    }
    if (target === poster) return jpgResponse();
    return mp4Response(57);
  });
  const result = await resolver(fetcher).resolve(requestedPin);
  expect(result.picker?.map(targetOf)).toEqual([video]);
  expect(fetcher.mock.calls.map(([input]) => String(input)).slice(1)).toEqual([
    requestedPin,
    video,
  ]);
});

it("rejects a Pinterest VideoObject when the page's marked Open Graph identity conflicts", async () => {
  const video = "https://v1.pinimg.com/videos/mc/720p/primary.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("PinResource")) return new Response(null, { status: 502 });
    if (String(input) === requestedPin)
      return html(
        `<head><link href="${requestedPin}" rel="canonical"></head>
       <body><meta data-app="true" property="og:url" content="https://www.pinterest.com/pin/1234567890123456790/">
       <script type="application/ld+json">${JSON.stringify({ "@type": "VideoObject", "@id": requestedPin, contentUrl: video })}</script></body>`,
      );
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedPin);
  expect(result.status).toBe("error");
  expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(video);
});

it("ignores another pin's HLS URL when the requested pin is a photo", async () => {
  const photo = "https://i.pinimg.com/736x/requested.jpg";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("PinResource")) return Response.json({ resource_response: {} });
    if (target === requestedPin) {
      return html(`${pinHead(`<meta property="og:image" content="${photo}">`)}
        <body><script type="application/json">{"url":"https://v1.pinimg.com/videos/hls/another.m3u8"}</script></body>`);
    }
    return jpgResponse();
  });
  const result = await resolver(fetcher).resolve(requestedPin);
  expect(result.picker?.map(targetOf)).toEqual([photo]);
});

it("falls back to the Pinterest page after every PinResource video fails verification", async () => {
  const stale = "https://v1.pinimg.com/videos/mc/720p/stale.mp4";
  const available = "https://v1.pinimg.com/videos/mc/480p/available.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("PinResource"))
      return Response.json({
        resource_response: {
          data: { id: tweetPinId, videos: { video_list: { V_720P: { url: stale } } } },
        },
      });
    if (target === stale) return html("<html>Previous video removed</html>");
    if (target === requestedPin)
      return html(pinHead(`<meta property="og:video" content="${available}">`));
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedPin);
  expect(result.picker?.map(targetOf)).toEqual([available]);
  expect(fetcher.mock.calls.map(([input]) => String(input)).slice(1)).toEqual([
    stale,
    requestedPin,
    available,
  ]);
});

it.each([
  [20_000, "public_media_file_unavailable"],
  [86_401_000, "error.api.content.too_long"],
] as const)(
  "preserves the Pinterest video error when only its poster survives (duration %i ms)",
  async (duration, code) => {
    const video = "https://v1.pinimg.com/videos/mc/720p/unavailable.mp4";
    const poster = "https://i.pinimg.com/736x/poster.jpg";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const target = String(input);
      if (target.includes("PinResource"))
        return Response.json({
          resource_response: {
            data: { id: tweetPinId, videos: { video_list: { V_720P: { url: video, duration } } } },
          },
        });
      if (target === requestedPin)
        return html(pinHead(`<meta property="og:image" content="${poster}">`));
      if (target === poster) return jpgResponse();
      return new Response(null, { status: 404 });
    });
    const result = await resolver(fetcher).resolve(requestedPin);
    expect(result.error?.code).toBe(code);
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(poster);
  },
);

it("checks the next ranked file when the preferred direct video is stale", async () => {
  const high = "https://video.twimg.com/ext_tw_video/1280x720/high.mp4";
  const low = "https://video.twimg.com/ext_tw_video/640x360/low.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("tweet-result"))
      return Response.json({
        id_str: tweetPinId,
        mediaDetails: [
          {
            type: "video",
            video_info: {
              variants: [
                { content_type: "video/mp4", bitrate: 256000, url: low },
                { content_type: "video/mp4", bitrate: 832000, url: high },
              ],
            },
          },
        ],
      });
    if (target === high) return new Response(null, { status: 404 });
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(`https://x.com/example/status/${tweetPinId}`);
  expect(result.picker?.map(targetOf)).toEqual([low]);
  expect(fetcher.mock.calls.map(([input]) => String(input)).slice(1)).toEqual([high, low]);
});

it("returns the existing duration error for source metadata above 24 hours", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      id_str: tweetPinId,
      mediaDetails: [
        {
          type: "video",
          video_info: {
            duration_millis: 86400001,
            variants: [
              { content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/long.mp4" },
            ],
          },
        },
      ],
    }),
  );
  const result = await resolver(fetcher).resolve(`https://x.com/example/status/${tweetPinId}`);
  expect(result.error?.code).toBe("error.api.content.too_long");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("reports the duration error when the video tool requests a mixed post with an oversized video", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    String(input).includes("tweet-result")
      ? Response.json({
          id_str: tweetPinId,
          mediaDetails: [
            {
              type: "video",
              video_info: {
                duration_millis: 86401000,
                variants: [
                  {
                    content_type: "video/mp4",
                    url: "https://video.twimg.com/ext_tw_video/long.mp4",
                  },
                ],
              },
            },
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/cover.jpg" },
          ],
        })
      : jpgResponse(),
  );
  const result = await resolver(fetcher).resolve(
    `https://x.com/example/status/${tweetPinId}`,
    "max",
    "video",
  );
  expect(result.error?.code).toBe("error.api.content.too_long");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("reads bounded MP4 duration metadata when a source gives no duration", async () => {
  const longVideo = "https://v1.pinimg.com/videos/mc/720p/long.mp4";
  const allowedVideo = "https://v1.pinimg.com/videos/mc/480p/allowed.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("PinResource"))
      return Response.json({
        resource_response: {
          data: {
            id: tweetPinId,
            videos: {
              video_list: {
                V_720P: { url: longVideo },
                V_480P: { url: allowedVideo },
              },
            },
          },
        },
      });
    return mp4Response(target === longVideo ? 86401 : 86400);
  });
  const result = await resolver(fetcher).resolve(requestedPin);
  expect(result.picker?.map(targetOf)).toEqual([allowedVideo]);
  expect(fetcher.mock.calls.map(([input]) => String(input)).slice(1)).toEqual([
    longVideo,
    allowedVideo,
  ]);
});

it("reads a tail movie header using the MP4 box offset and rejects its long duration", async () => {
  const video = "https://video.twimg.com/ext_tw_video/tail-movie.mp4";
  const movieOffset = 131072;
  const head = new Uint8Array(65536);
  head.set(movieHeader(15).subarray(0, 16));
  new DataView(head.buffer).setUint32(16, movieOffset - 16);
  head.set(new TextEncoder().encode("mdat"), 20);
  const tail = movieHeader(86401).subarray(16);
  const total = movieOffset + tail.length;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes("tweet-result"))
      return Response.json({
        id_str: tweetPinId,
        mediaDetails: [
          { type: "video", video_info: { variants: [{ content_type: "video/mp4", url: video }] } },
        ],
      });
    const range = new Headers(init?.headers).get("range");
    if (range === "bytes=0-65535") {
      return new Response(head, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": `bytes 0-65535/${total}`,
        },
      });
    }
    if (range === `bytes=${movieOffset}-${total - 1}`) {
      return new Response(tail, {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": `bytes ${movieOffset}-${total - 1}/${total}`,
        },
      });
    }
    throw new Error(`unexpected range ${range}`);
  });
  const result = await resolver(fetcher).resolve(`https://x.com/example/status/${tweetPinId}`);
  expect(result.error?.code).toBe("error.api.content.too_long");
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("rejects an off-site Pinterest short redirect before following it", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.redirect(`https://www.pinterest.com.evil.example/pin/${tweetPinId}`),
  );
  const result = await resolver(fetcher).resolve("https://pin.it/BadLink");
  expect(result.status).toBe("error");
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(["pin", "off-site", "terminal relay"] as const)(
  "follows the Pinterest shortener relay only to a recognized pin (%s)",
  async (destination) => {
    const short = "https://pin.it/Idea9Pin";
    const relay = "https://api.pinterest.com/url_shortener/Idea9Pin/redirect/";
    const photo = "https://i.pinimg.com/736x/linked-pin.jpg";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const target = String(input);
      if (target === short) return Response.redirect(relay);
      if (target === relay) {
        if (destination === "terminal relay") return html(pinHead(""));
        return Response.redirect(destination === "pin" ? requestedPin : "https://example.org/");
      }
      if (target.includes("/resource/PinResource/"))
        return Response.json({
          resource_response: { data: { id: tweetPinId, images: { orig: { url: photo } } } },
        });
      if (target === photo) return jpgResponse();
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await resolver(fetcher).resolve(short);
    if (destination === "pin") {
      expect(result.picker?.map(targetOf)).toEqual([photo]);
    } else {
      expect(result.status).toBe("error");
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([short, relay]);
    }
  },
);

it("reports unsupported Pinterest HLS if no direct video is available", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (!String(input).startsWith("https://www.pinterest.com/")) throw new Error("external fetch");
    if (!String(input).includes("PinResource"))
      return html(
        pinHead('<meta property="og:image" content="https://i.pinimg.com/736x/stream-poster.jpg">'),
      );
    return Response.json({
      resource_response: {
        data: {
          videos: {
            video_list: {
              V_HLSV4: { url: "https://v1.pinimg.com/videos/hls/stream.m3u8" },
            },
          },
        },
      },
    });
  });
  const result = await resolver(fetcher).resolve(`https://pinterest.com/pin/${tweetPinId}/`);
  expect(result.error?.code).toBe("public_media_stream_only");
});

it.each([false, true])(
  "preserves playlist evidence after a stale PinResource video when the page advertises another stale video = %s",
  async (withStalePageVideo) => {
    const stale = "https://v1.pinimg.com/videos/mc/720p/stale.mp4";
    const stalePageVideo = "https://v1.pinimg.com/videos/mc/480p/stale-page.mp4";
    const playlist = "https://v1.pinimg.com/videos/hls/playlist.m3u8";
    const poster = "https://i.pinimg.com/736x/poster.jpg";
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const target = String(input);
      if (target.includes("PinResource"))
        return Response.json({
          resource_response: {
            data: {
              id: tweetPinId,
              videos: {
                video_list: {
                  V_720P: { url: stale },
                  V_HLSV4: { url: playlist },
                },
              },
            },
          },
        });
      if (target === requestedPin) {
        const videoTag = withStalePageVideo
          ? `<meta property="og:video" content="${stalePageVideo}">`
          : "";
        return html(pinHead(`<meta property="og:image" content="${poster}">${videoTag}`));
      }
      if (target === poster) return jpgResponse();
      return new Response(null, { status: 404 });
    });
    const result = await resolver(fetcher).resolve(requestedPin);
    expect(result.error?.code).toBe("public_media_stream_only");
    expect(fetcher.mock.calls.map(([input]) => String(input)).slice(1)).toEqual(
      withStalePageVideo ? [stale, requestedPin, stalePageVideo] : [stale, requestedPin],
    );
  },
);

it("rejects an HLS-only fallback page with an Open Graph cover", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("PinResource")) return Response.json({ resource_response: {} });
    return html(
      pinHead(
        '<meta property="og:image" content="https://i.pinimg.com/736x/poster.jpg"><meta property="og:video" content="https://v1.pinimg.com/videos/hls/stream.m3u8">',
      ),
    );
  });
  const result = await resolver(fetcher).resolve(`https://pinterest.com/pin/${tweetPinId}/`);
  expect(result.error?.code).toBe("public_media_stream_only");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("uses only the primary LinkedIn embed after a same-platform access redirect", async () => {
  const decoy = "https://dms.licdn.com/dms/video/recommendation.mp4";
  const requested = "https://dms.licdn.com/dms/video/requested.mp4";
  const primaryEmbed = `https://www.linkedin.com/embed/feed/update/urn:li:activity:${tweetPinId}`;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    if (target.pathname.startsWith("/posts/"))
      return Response.redirect("https://www.linkedin.com/signup");
    if (target.pathname === "/signup") return html(`<main>${linkedInVideo(decoy)}</main>`);
    if (target.href === primaryEmbed)
      return html(`<main>${linkedInPost(linkedInVideo(requested))}<section class="related-posts">${linkedInVideo(decoy)}</section></main>
        <aside>${linkedInVideo(decoy)}</aside>`);
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedActivity);
  expect(result.picker?.map(targetOf)).toEqual([requested]);
  expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(decoy);
});

it("ignores LinkedIn activity markup stored in a script before the primary article", async () => {
  const decoy = "https://dms.licdn.com/dms/video/serialized-recommendation.mp4";
  const primary = "https://dms.licdn.com/dms/video/primary.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("/posts/"))
      return html(
        `<script type="application/json">${JSON.stringify({ suggested: linkedInPost(linkedInVideo(decoy)) + "<div id='authwall'></div>" })}</script>
       <!-- ${linkedInPost(linkedInVideo(decoy))} -->
       ${linkedInPost(linkedInVideo(primary))}`,
      );
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedActivity);
  expect(result.picker?.map(targetOf)).toEqual([primary]);
  expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(decoy);
});

it("ignores identifier-free LinkedIn access pages and non-primary embed recommendations", async () => {
  const decoy = "https://dms.licdn.com/dms/video/recommendation.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    if (target.pathname.startsWith("/posts/"))
      return html(`<title>Sign in | LinkedIn</title><main>${linkedInVideo(decoy)}</main>`);
    if (target.pathname.startsWith("/embed/"))
      return html(`<aside>${linkedInVideo(decoy)}</aside>`);
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedActivity);
  expect(result.error?.code).toBe("public_media_blocked");
  expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(decoy);
});

it("falls back to the LinkedIn embed when the associated public post points to a stale file", async () => {
  const stale = "https://dms.licdn.com/dms/video/stale.mp4";
  const available = "https://dms.licdn.com/dms/video/available.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    if (target.pathname.startsWith("/posts/")) return html(linkedInPost(linkedInVideo(stale)));
    if (target.pathname.startsWith("/embed/"))
      return html(`<main>${linkedInPost(linkedInVideo(available))}</main>`);
    if (target.href === stale) return new Response(null, { status: 403 });
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedActivity);
  expect(result.picker?.map(targetOf)).toEqual([available]);
});

it("uses LinkedIn duration only from the JSON-LD associated with the requested activity", async () => {
  const video = "https://dms.licdn.com/dms/video/requested.mp4";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    if (target.pathname.startsWith("/posts/"))
      return html(`
      <script type="application/ld+json">${JSON.stringify({ "@type": "VideoObject", "@id": requestedActivity, contentUrl: video, duration: "PT24H1S" })}</script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "VideoObject", "@id": requestedActivity.replace(tweetPinId, "1234567890123456790"), contentUrl: video, duration: "PT15S" })}</script>
      ${linkedInPost(linkedInVideo(video))}`);
    if (target.pathname.startsWith("/embed/")) return html("<main>Public post</main>");
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(requestedActivity);
  expect(result.error?.code).toBe("error.api.content.too_long");
  expect(fetcher.mock.calls.map(([input]) => String(input))).not.toContain(video);
});

it("does not apply a LinkedIn duration to a different CDN video asset", async () => {
  const longVideo = "https://dms.licdn.com/dms/video/v2/long/mp4-720p";
  const shortVideo = "https://dms.licdn.com/dms/video/v2/short/mp4-360p";
  const schema = {
    "@type": "VideoObject",
    "@id": requestedActivity,
    contentUrl: shortVideo,
    duration: "PT15S",
  };
  const player = `<video data-sources="${encoded([
    { src: longVideo, type: "video/mp4", "data-bitrate": 720 },
    { src: shortVideo, type: "video/mp4", "data-bitrate": 360 },
  ])}"></video>`;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("/posts/")) {
      return html(`<title>How to sign in to your new tool | LinkedIn</title>
        <script type="application/ld+json">${JSON.stringify(schema)}</script>
        ${linkedInPost(player)}`);
    }
    if (target === longVideo) return mp4Response(86401);
    return mp4Response(15);
  });
  const result = await resolver(fetcher).resolve(requestedActivity);
  expect(result.picker?.map(targetOf)).toEqual([shortVideo]);
  expect(fetcher.mock.calls.map(([input]) => String(input)).slice(1)).toEqual([
    longVideo,
    shortVideo,
  ]);
});

it.each([403, 404, 429])("reports an X CDN %s as an unavailable file", async (status) => {
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    String(input).includes("tweet-result")
      ? Response.json({
          id_str: tweetPinId,
          mediaDetails: [
            { type: "photo", media_url_https: "https://pbs.twimg.com/media/stale.jpg" },
          ],
        })
      : new Response(null, { status }),
  );
  const result = await resolver(fetcher).resolve(`https://x.com/example/status/${tweetPinId}`);
  expect(result.error?.code).toBe("public_media_file_unavailable");
});

it("reports a LinkedIn manifest 404 as an unavailable file", async () => {
  const manifest = "https://media.licdn.com/dms/document/stale-manifest";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = new URL(String(input));
    if (target.pathname.startsWith("/posts/"))
      return html(
        linkedInPost(
          `<div data-native-document-config="${encoded({ doc: { manifestUrl: manifest } })}"></div>`,
        ),
      );
    if (target.pathname.startsWith("/embed/")) return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  });
  const result = await resolver(fetcher).resolve(requestedActivity);
  expect(result.error?.code).toBe("public_media_file_unavailable");
});

it("uses LinkedIn's public embed after an authwall and reads ordered largest-resolution pages", async () => {
  const manifest = "https://dms.licdn.com/dms/document/config";
  const smallManifest = "https://media.licdn.com/dms/document/small";
  const largeManifest = "https://media.licdn.com/dms/document/large";
  const pdfUrl = "https://media.licdn.com/dms/document/report.pdf?e=1&v=2";
  const pages = ["third-name", "first-name"].map(
    (name) =>
      `https://media.licdn.com/dms/image/v2/document/feedshare-document-images_1920/${name}.jpg`,
  );
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("www.linkedin.com/feed/update/")) return html("LinkedIn authwall");
    if (target.includes("www.linkedin.com/embed/feed/update/"))
      return html(
        linkedInPost(
          `<div data-native-document-config="${encoded({ doc: { manifestUrl: manifest, totalPageCount: 2 } })}"></div>`,
        ),
      );
    if (target === manifest)
      return Response.json({
        transcribedDocumentUrl: pdfUrl,
        perResolutions: [
          { width: 1400, imageManifestUrl: largeManifest },
          { width: 200, imageManifestUrl: smallManifest },
        ],
      });
    if (target === largeManifest)
      return Response.json({ pages: [{ url: pages[0] }, { imageUrl: pages[1] }] });
    if (target === pdfUrl)
      return new Response(pdf, { headers: { "content-type": "application/octet-stream" } });
    if (pages.includes(target)) {
      return new Response(jpg, {
        status: 206,
        headers: {
          "content-type": "image/jpeg",
          "content-range": "bytes 0-15/637976",
          "content-length": "16",
        },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  const client = resolver(fetcher);
  const result = await client.resolve(
    `https://www.linkedin.com/feed/update/urn:li:activity:${tweetPinId}/`,
  );
  expect(result.picker.map(targetOf)).toEqual([pdfUrl, ...pages]);
  expect(result.picker[0]).toMatchObject({
    type: "document",
    filename: expect.stringMatching(/\.pdf$/u),
  });
  const download = await client.download(result.picker[0].url);
  expect(download.headers.get("content-type")).toBe("application/pdf");
  expect(download.headers.get("content-disposition")).toBe(
    `attachment; filename="${result.picker[0].filename}"`,
  );
  expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([...pdf]);
});

it("returns only the full LinkedIn PDF when its page count exceeds the item capacity", async () => {
  const manifest = "https://dms.licdn.com/dms/document/config";
  const pdfUrl = "https://media.licdn.com/dms/document/report.pdf";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("www.linkedin.com/posts/"))
      return html(
        linkedInPost(
          `<div data-native-document-config='${encoded({ doc: { manifestUrl: manifest, totalPageCount: 20 } })}'></div>`,
        ),
      );
    if (target === manifest)
      return Response.json({
        transcribedDocumentUrl: pdfUrl,
        perResolutions: [
          { width: 1000, imageManifestUrl: "https://media.licdn.com/dms/document/large" },
        ],
      });
    if (target === pdfUrl) return new Response(pdf);
    throw new Error(`unexpected fetch: ${target}`);
  });
  const result = await resolver(fetcher).resolve(
    `https://www.linkedin.com/posts/team_activity-${tweetPinId}-eyXK`,
  );
  expect(result.picker.map(targetOf)).toEqual([pdfUrl]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each(["PDF", "page"] as const)(
  "returns complete LinkedIn document formats when a %s is stale",
  async (stale) => {
    const manifest = "https://media.licdn.com/dms/document/manifest";
    const pageList = "https://media.licdn.com/dms/document/pages";
    const pdfUrl = "https://media.licdn.com/dms/document/report.pdf";
    const pages = ["d", "c", "b", "a"].map(
      (name) => `https://media.licdn.com/dms/image/v2/${name}.jpg`,
    );
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const target = String(input);
      if (target.startsWith("https://www.linkedin.com/"))
        return html(
          linkedInPost(
            `<div data-native-document-config="${encoded({ doc: { manifestUrl: manifest, totalPageCount: 4 } })}"></div>`,
          ),
        );
      if (target === manifest)
        return Response.json({
          transcribedDocumentUrl: pdfUrl,
          perResolutions: [{ width: 1920, imageManifestUrl: pageList }],
        });
      if (target === pageList) return Response.json({ pages });
      if (target === (stale === "PDF" ? pdfUrl : pages[1]))
        return new Response(null, { status: 404 });
      if (target === pdfUrl)
        return new Response(pdf, { headers: { "content-type": "application/pdf" } });
      if (pages.includes(target)) return jpgResponse();
      throw new Error(`unexpected fetch: ${target}`);
    });
    const result = await resolver(fetcher).resolve(requestedActivity);
    expect(result.picker?.map(targetOf)).toEqual(stale === "PDF" ? pages : [pdfUrl]);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/embed/"))).toBe(false);
  },
);

it("refuses hostile LinkedIn manifest URLs and redirects even when a document is the only asset", async () => {
  const trustedManifest = "https://media.licdn.com/dms/document/report/master";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("www.linkedin.com/posts/")) {
      return html(
        linkedInPost(
          `<iframe data-native-document-config="${encoded({ doc: { manifestUrl: "https://127.0.0.1/metadata" } })}"></iframe>`,
        ),
      );
    }
    if (target.includes("www.linkedin.com/embed/")) {
      return html(
        linkedInPost(
          `<iframe data-native-document-config="${encoded({ doc: { manifestUrl: trustedManifest } })}"></iframe>`,
        ),
      );
    }
    if (target === trustedManifest)
      return Response.redirect("https://media.licdn.com.evil.example/dms/document/report/master");
    throw new Error(`unexpected fetch: ${target}`);
  });
  const result = await resolver(fetcher).resolve(
    `https://linkedin.com/posts/team_activity-${tweetPinId}-post`,
  );
  expect(result.status).toBe("error");
  expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
    `https://www.linkedin.com/posts/team_activity-${tweetPinId}-post/`,
    `https://www.linkedin.com/embed/feed/update/urn:li:activity:${tweetPinId}`,
    trustedManifest,
  ]);
});

it("selects an HTML-encoded LinkedIn MP4 variant by bitrate and never reads an untrusted manifest", async () => {
  const best = "https://dms.licdn.com/dms/video/avc1/mp4-720p?e=1&v=2";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("www.linkedin.com/")) {
      return html(
        linkedInPost(
          `<video data-sources="${encoded([
            {
              src: "https://dms.licdn.com/dms/video/mp4-360p",
              type: "video/mp4",
              "data-bitrate": 360,
            },
            { src: best, type: "video/mp4", "data-bitrate": "720" },
          ])}"></video><div data-native-document-config="${encoded({ doc: { manifestUrl: "https://127.0.0.1/metadata" } })}"></div>`,
        ),
      );
    }
    expect(String(input)).toBe(best);
    return mp4Response();
  });
  const result = await resolver(fetcher).resolve(
    `https://linkedin.com/posts/team_activity-${tweetPinId}-post`,
  );
  expect(result.picker.map(targetOf)).toEqual([best]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("reads a requested LinkedIn article's nested document and ignores recommended videos", async () => {
  const manifest = "https://media.licdn.com/dms/document/pl/v2/report/master-manifest";
  const pdfUrl = "https://media.licdn.com/dms/document/pl/v2/report/full-document";
  const badManifest = "https://media.licdn.com/dms/document/pl/v2/advertisement/master-manifest";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const target = String(input);
    if (target.includes("www.linkedin.com/posts/")) {
      return html(`
        <iframe data-native-document-config="${encoded({ doc: { manifestUrl: badManifest } })}"></iframe>
        <article class="main-feed-activity-card" data-activity-urn="urn:li:activity:${tweetPinId}">
          <article data-activity-urn="urn:li:activity:7469675915015331840">
            <iframe data-native-document-config="${encoded({ doc: { manifestUrl: manifest } })}"></iframe>
          </article>
        </article>
        <section class="related-posts">
          <article data-activity-urn="urn:li:activity:7467577287576670211">
            <video data-sources="${encoded([{ type: "video/mp4", src: "https://dms.licdn.com/dms/video/unrelated.mp4" }])}"></video>
          </article>
        </section>`);
    }
    if (target === manifest) return Response.json({ transcribedDocumentUrl: pdfUrl });
    if (target === pdfUrl) return new Response(pdf);
    throw new Error(`unexpected fetch: ${target}`);
  });
  const result = await resolver(fetcher).resolve(
    `https://www.linkedin.com/posts/team_activity-${tweetPinId}-post`,
  );
  expect(result.picker.map(targetOf)).toEqual([pdfUrl]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("deduplicates LinkedIn feedshare images by ID and retains original ID order", async () => {
  const firstIdBase = "https://media.licdn.com/dms/image/v2/D4D22AQHJ/foo/feedshare-shrink_";
  const secondId = "https://media.licdn.com/dms/image/v2/D4D22AQHZ/foo/feedshare-shrink_800";
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    String(input).includes("www.linkedin.com/")
      ? html(
          linkedInPost(
            `<img src="${firstIdBase}400?e=1&amp;v=2"><img src="${secondId}"><img src="${firstIdBase}2048">`,
          ),
        )
      : jpgResponse(),
  );
  const result = await resolver(fetcher).resolve(
    `https://www.linkedin.com/posts/team_activity-${tweetPinId}-post`,
  );
  expect(result.picker.map(targetOf)).toEqual([`${firstIdBase}2048`, secondId]);
});

it("revalidates download magic and each redirect, even for HEAD", async () => {
  const source = "https://pbs.twimg.com/media/photo.jpg";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("tweet-result"))
      return Response.json({
        id_str: tweetPinId,
        mediaDetails: [{ type: "photo", media_url_https: source }],
      });
    return jpgResponse();
  });
  const client = resolver(fetcher);
  const {
    picker: [item],
  } = await client.resolve(`https://x.com/user/status/${tweetPinId}`);
  fetcher.mockImplementationOnce(
    async () =>
      new Response('<?xml version="1.0"?><Error/>', { headers: { "content-type": "image/jpeg" } }),
  );
  const invalidHead = await client.download(item.url, { method: "HEAD" });
  expect(invalidHead.status).toBe(502);
  await invalidHead.body?.cancel();
  fetcher.mockImplementationOnce(
    async () => new Response(jpg, { headers: { "content-type": "text/html" } }),
  );
  const invalidDownload = await client.download(item.url);
  expect(invalidDownload.status).toBe(502);
  await invalidDownload.body?.cancel();
  fetcher
    .mockClear()
    .mockImplementationOnce(async () =>
      Response.redirect("https://pbs.twimg.com.evil.example/media/photo.jpg"),
    );
  const unsafeRedirect = await client.download(item.url);
  expect(unsafeRedirect.status).toBe(502);
  await unsafeRedirect.body?.cancel();
  expect(fetcher).toHaveBeenCalledOnce();
});

it("enforces public file size limits before starting a download", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("tweet-result"))
      return Response.json({
        id_str: tweetPinId,
        mediaDetails: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/photo.jpg" }],
      });
    return jpgResponse();
  });
  const client = resolver(fetcher);
  const {
    picker: [item],
  } = await client.resolve(`https://x.com/user/status/${tweetPinId}`);
  fetcher.mockImplementationOnce(
    async () =>
      new Response(jpg, {
        headers: { "content-type": "image/jpeg", "content-length": "20971521" },
      }),
  );
  const response = await client.download(item.url);
  expect(response.status).toBe(413);
  await response.body?.cancel();
});

it("rejects changes to the signed public media platform, URL, type, filename and expiry", async () => {
  const now = Date.UTC(2026, 0, 1);
  vi.useFakeTimers({ now, toFake: ["Date"] });
  const source = "https://pbs.twimg.com/media/photo.jpg";
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("tweet-result"))
      return Response.json({
        id_str: tweetPinId,
        mediaDetails: [{ type: "photo", media_url_https: source }],
      });
    return jpgResponse();
  });
  const client = resolver(fetcher);
  const {
    picker: [item],
  } = await client.resolve(`https://x.com/user/status/${tweetPinId}`);
  const control = await client.download(item.url);
  expect(control.status).toBe(200);
  expect(new Uint8Array(await control.arrayBuffer())).toEqual(jpg);
  const nowSeconds = now / 1000;
  expect(new URL(item.url).searchParams.get("expires")).toBe(String(nowSeconds + 90));
  fetcher.mockClear();
  const mutations: Record<string, string>[] = [
    { src: "https://pbs.twimg.com/media/other.jpg" },
    { platform: "pinterest" },
    { type: "image/png" },
    { bento_filename: "other.jpg" },
    { expires: "1" },
    { bento_filename: `twitter-${tweetPinId}-02.jpg` },
    { expires: String(nowSeconds + 60) },
    { type: "image/png", bento_filename: `twitter-${tweetPinId}.png` },
  ];
  for (const mutation of mutations) {
    const tampered = new URL(item.url);
    for (const [key, value] of Object.entries(mutation)) tampered.searchParams.set(key, value);
    const response = await client.download(tampered);
    expect(response.status).toBe(404);
    await response.body?.cancel();
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("uses the existing stream rate and concurrency gates for signed public assets", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes("tweet-result"))
      return Response.json({
        id_str: tweetPinId,
        mediaDetails: [
          { type: "photo", media_url_https: "https://pbs.twimg.com/media/stream.jpg" },
        ],
      });
    return jpgResponse();
  });
  const limit = vi.fn(async () => ({ success: true }));
  const client = resolver(fetcher, limit);
  const {
    picker: [item],
  } = await client.resolve(`https://x.com/user/status/${tweetPinId}`);
  fetcher.mockClear();
  limit.mockResolvedValueOnce({ success: false });
  const denied = await client.download(item.url, {
    headers: { "cf-connecting-ip": "203.0.113.9" },
  });
  expect(denied.status).toBe(429);
  expect(limit).toHaveBeenCalledWith({ key: "media-tunnel:203.0.113.9" });
  await denied.body?.cancel();
  expect(fetcher).not.toHaveBeenCalled();

  fetcher.mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(jpg) }),
        {
          headers: { "content-type": "image/jpeg" },
        },
      ),
  );
  const active = await Promise.all(Array.from({ length: 4 }, () => client.download(item.url)));
  try {
    expect(active.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const overCapacity = await client.download(item.url);
    expect(overCapacity.status).toBe(429);
    expect(overCapacity.headers.get("retry-after")).toBe("15");
  } finally {
    await Promise.all(active.map((response) => response.body?.cancel()));
  }
});
