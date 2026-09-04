import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaBelongsToCreator } from "./social-scheduler.functions";
import {
  deriveSocialPostStatus,
  isPublicSocialProvider,
  parseRetryAfterSeconds,
  prepareSchedulerMediaFiles,
  providerSettingsMedia,
  PUBLIC_SOCIAL_PROVIDERS,
  schedulerCaptionLabel,
  schedulerMediaCompatibility,
  schedulerPostEngagement,
  socialAccountsWithinLimit,
  socialCalendarDateKey,
  socialCalendarDates,
  isSocialCalendarPost,
  scheduleTimeForDate,
  defaultScheduleTime,
  minimumScheduleTime,
  nextPostingSlot,
  postingScheduleSchema,
  isSchedulableCalendarDay,
  socialPostInputSchema,
  socialConnectionCanPublish,
  socialRetryDelaySeconds,
  summarizeSchedulerOperations,
  tiktokCoverTimestampMs,
  clampTikTokCoverTimestampMs,
  validatePostForProviders,
  youtubeDescriptionForUpload,
  youtubeDescriptionFrom,
  youtubeDetectedFormat,
  youtubePublishedUrl,
  resolvedYouTubeFormat,
  type SchedulerMedia,
  type SchedulerPost,
} from "./social-scheduler";

const image: SchedulerMedia = {
  key: "users/user/image/file.jpg",
  url: "https://bento.surf/cdn/users/user/image/file.jpg",
  name: "file.jpg",
  mimeType: "image/jpeg",
  size: 100,
};
const video = { ...image, key: "video.mp4", name: "video.mp4", mimeType: "video/mp4" };

describe("social scheduler validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("only shows engagement after analytics have been fetched", () => {
    expect(schedulerPostEngagement([{ likes: null, comments: null }])).toEqual({
      likes: null,
      comments: null,
    });
    expect(
      schedulerPostEngagement([
        { likes: 4, comments: 0 },
        { likes: 3, comments: 2 },
      ]),
    ).toEqual({ likes: 7, comments: 2 });
  });

  it("hides Reddit from the public Connect provider list", () => {
    expect(PUBLIC_SOCIAL_PROVIDERS).not.toContain("reddit");
    expect(isPublicSocialProvider("reddit")).toBe(false);
    expect(isPublicSocialProvider("youtube")).toBe(true);
  });

  it("keeps reconnects while limiting each provider to two distinct profiles", () => {
    const accounts = [{ id: "one" }, { id: "two" }, { id: "three" }, { id: "three" }];
    expect(socialAccountsWithinLimit([], accounts).map((account) => account.id)).toEqual([
      "one",
      "two",
    ]);
    expect(
      socialAccountsWithinLimit(["one", "two"], accounts).map((account) => account.id),
    ).toEqual(["one", "two"]);
  });

  it("builds Monday-first week and six-row month calendar ranges", () => {
    const cursor = new Date(2026, 7, 15);
    const week = socialCalendarDates(cursor, "week");
    const month = socialCalendarDates(cursor, "month");
    expect(week).toHaveLength(7);
    expect(week[0]?.getDay()).toBe(1);
    expect(month).toHaveLength(42);
    expect(month[0]?.getDay()).toBe(1);
    expect(socialCalendarDateKey(cursor)).toBe("2026-08-15");
  });

  it("keeps unscheduled drafts off the publishing calendar", () => {
    expect(isSocialCalendarPost({ status: "draft", scheduledAt: null })).toBe(false);
    expect(isSocialCalendarPost({ status: "draft", scheduledAt: new Date().toISOString() })).toBe(
      false,
    );
    expect(
      isSocialCalendarPost({ status: "cancelled", scheduledAt: new Date().toISOString() }),
    ).toBe(false);
    expect(
      isSocialCalendarPost({ status: "scheduled", scheduledAt: new Date().toISOString() }),
    ).toBe(true);
  });

  it("validates recurring posting slots", () => {
    expect(
      postingScheduleSchema.safeParse({
        timezone: "Asia/Kolkata",
        naturalOffset: false,
        slots: [
          { day: 1, time: "12:00" },
          { day: 5, time: "17:30" },
        ],
      }).success,
    ).toBe(true);
    expect(
      postingScheduleSchema.safeParse({
        timezone: "Not/A_Timezone",
        naturalOffset: false,
        slots: [{ day: 8, time: "25:00" }],
      }).success,
    ).toBe(false);
  });

  it("finds the next unoccupied posting slot in the account timezone", () => {
    const slots = [
      { day: 1, time: "12:00" },
      { day: 1, time: "17:00" },
      { day: 3, time: "09:00" },
    ];
    const first = nextPostingSlot(slots, "Asia/Kolkata", new Date("2026-08-17T05:00:00Z"));
    expect(first).toBe("2026-08-17T06:30:00.000Z");
    expect(nextPostingSlot(slots, "Asia/Kolkata", new Date("2026-08-17T05:00:00Z"), [first!])).toBe(
      "2026-08-17T11:30:00.000Z",
    );
    expect(nextPostingSlot(slots, "Asia/Kolkata", new Date("2026-08-17T05:00:00Z"), [], 4)).toBe(
      "2026-08-17T06:34:00.000Z",
    );
    expect(nextPostingSlot([], "Asia/Kolkata", new Date("2026-08-17T05:00:00Z"))).toBeNull();
  });

  it("requires a YouTube title and keeps Instagram on a caption", () => {
    expect(validatePostForProviders("A caption", [video], ["youtube"]).youtube).toContain("title");
    expect(validatePostForProviders("A caption", [video], ["youtube"], "A video title")).toEqual(
      {},
    );
    expect(validatePostForProviders("A caption", [image], ["instagram"])).toEqual({});
    expect(schedulerCaptionLabel(["instagram"])).toBe("Caption");
    expect(schedulerCaptionLabel(["tiktok"])).toBe("Caption");
    expect(schedulerCaptionLabel(["instagram", "tiktok"])).toBe("Caption");
    expect(schedulerCaptionLabel(["linkedin"])).toBe("Post text");
    expect(schedulerCaptionLabel(["twitter"])).toBe("Post");
  });

  it("uses a YouTube description override when caption and video copy differ", () => {
    expect(youtubeDescriptionFrom("Instagram caption", {})).toBe("Instagram caption");
    expect(youtubeDescriptionFrom("Instagram caption", { description: " Watch notes " })).toBe(
      "Watch notes",
    );
    expect(
      validatePostForProviders("short", [video], ["youtube"], "Title", {
        youtube: { description: "x".repeat(5_001) },
      }).youtube,
    ).toContain("5,000");
  });

  it("classifies YouTube Shorts from duration and aspect ratio, not a separate API", () => {
    expect(youtubeDetectedFormat({ durationSeconds: 42, width: 1080, height: 1920 })).toBe("short");
    expect(youtubeDetectedFormat({ durationSeconds: 180, width: 1080, height: 1080 })).toBe(
      "short",
    );
    expect(youtubeDetectedFormat({ durationSeconds: 181, width: 1080, height: 1920 })).toBe(
      "video",
    );
    expect(youtubeDetectedFormat({ durationSeconds: 20, width: 1920, height: 1080 })).toBe("video");
    expect(youtubeDetectedFormat(null)).toBeNull();
    expect(youtubeDetectedFormat({ durationSeconds: 12, width: 0, height: 0 })).toBeNull();
    expect(resolvedYouTubeFormat("auto", "short")).toBe("short");
    expect(resolvedYouTubeFormat("video", "short")).toBe("video");
    expect(youtubeDescriptionForUpload("Watch notes", { description: " Override " })).toBe(
      "Override",
    );
    expect(youtubePublishedUrl("abc", "short")).toBe("https://www.youtube.com/shorts/abc");
    expect(youtubePublishedUrl("abc", "video")).toBe("https://www.youtube.com/watch?v=abc");
  });

  it("validates YouTube thumbnails and Instagram reel covers separately from post media", () => {
    const thumbnail = { ...image, key: "users/user/image/thumb.jpg", name: "thumb.jpg" };
    expect(
      validatePostForProviders("A caption", [video], ["youtube"], "Title", {
        youtube: { thumbnail },
      }),
    ).toEqual({});
    expect(
      validatePostForProviders("A caption", [video], ["instagram"], "", {
        instagram: { cover: thumbnail },
      }),
    ).toEqual({});
    expect(
      validatePostForProviders("A caption", [video], ["youtube"], "Title", {
        youtube: { thumbnail: video },
      }).youtube,
    ).toContain("JPEG");
    expect(
      validatePostForProviders("A caption", [image, video], ["instagram"], "", {
        instagram: { cover: thumbnail },
      }).instagram,
    ).toContain("Reel");
    expect(
      providerSettingsMedia({ youtube: { thumbnail }, instagram: { cover: thumbnail } }),
    ).toEqual([thumbnail, thumbnail]);
  });

  it("defaults TikTok cover frames to one second and clamps them inside the video", () => {
    expect(tiktokCoverTimestampMs({})).toBe(1_000);
    expect(tiktokCoverTimestampMs({ videoCoverTimestampMs: 2_400 })).toBe(2_400);
    expect(clampTikTokCoverTimestampMs(1_000, 500)).toBe(499);
    expect(clampTikTokCoverTimestampMs(0, 8_000)).toBe(0);
    expect(
      validatePostForProviders("A caption", [video], ["tiktok"], "", {
        tiktok: { videoCoverTimestampMs: -12 },
      }).tiktok,
    ).toContain("thumbnail frame");
  });

  it("enforces TikTok privacy, duration, and commercial-content disclosures", () => {
    expect(validatePostForProviders("hello", [video], ["tiktok"]).tiktok).toContain("privacy");
    expect(
      validatePostForProviders("hello", [video], ["tiktok"], "", {
        tiktok: { privacyLevel: "SELF_ONLY", commercialContent: true },
      }).tiktok,
    ).toContain("promotes");
    expect(
      validatePostForProviders("hello", [video], ["tiktok"], "", {
        tiktok: { privacyLevel: "SELF_ONLY", brandContentToggle: true },
      }).tiktok,
    ).toContain("branded content");
    expect(
      validatePostForProviders("hello", [video], ["tiktok"], "", {
        tiktok: {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          videoDurationSeconds: 61,
          maxVideoPostDurationSec: 60,
        },
      }).tiktok,
    ).toContain("60 seconds");
    expect(
      validatePostForProviders("hello", [video], ["tiktok"], "", {
        tiktok: { privacyLevel: "SELF_ONLY" },
      }),
    ).toEqual({});
  });

  it("requires media for Instagram and video for YouTube and TikTok", () => {
    expect(validatePostForProviders("hello", [], ["instagram"]).instagram).toContain("image");
    expect(validatePostForProviders("hello", [image], ["youtube"]).youtube).toContain("video");
    expect(
      validatePostForProviders("hello", [video], ["youtube", "tiktok"], "A video title", {
        tiktok: { privacyLevel: "SELF_ONLY" },
      }),
    ).toEqual({});
  });

  it("accepts X images and rejects mixed media combinations", () => {
    expect(validatePostForProviders("hello", [image], ["twitter"])).toEqual({});
    expect(validatePostForProviders("hello", [video], ["twitter"])).toEqual({});
    expect(validatePostForProviders("hello", [image, video], ["twitter"]).twitter).toContain(
      "cannot mix",
    );
    expect(
      validatePostForProviders("hello", [image, image, image, image, image], ["twitter"]).twitter,
    ).toContain("up to 4");
  });

  it("does not silently discard media on text-only adapters", () => {
    expect(validatePostForProviders("hello", [image], ["reddit"]).reddit).toContain("text-only");
  });

  it("accepts creator media from configured split origins", () => {
    vi.stubEnv("VITE_APP_URL", "https://app.example");
    vi.stubEnv("VITE_PUBLIC_URL", "https://public.example");

    expect(
      mediaBelongsToCreator(
        { ...image, url: "https://public.example/cdn/users/user/image/file.jpg" },
        "user",
      ),
    ).toBe(true);
    expect(
      mediaBelongsToCreator(
        { ...image, url: "https://app.example/cdn/users/user/image/file.jpg" },
        "user",
      ),
    ).toBe(true);
  });

  it("rejects media from unconfigured origins or another creator", () => {
    vi.stubEnv("VITE_APP_URL", "https://app.example");
    vi.stubEnv("VITE_PUBLIC_URL", "https://public.example");

    expect(mediaBelongsToCreator(image, "user")).toBe(false);
    expect(
      mediaBelongsToCreator(
        { ...image, url: "https://public.example/cdn/users/user/image/file.jpg" },
        "someone-else",
      ),
    ).toBe(false);
    expect(mediaBelongsToCreator({ ...image, url: "https://example.com/image.jpg" }, "user")).toBe(
      false,
    );
    expect(
      mediaBelongsToCreator(
        {
          ...image,
          key: "users/user/../someone-else/image.jpg",
          url: "https://public.example/cdn/users/user/../someone-else/image.jpg",
        },
        "user",
      ),
    ).toBe(false);
  });

  it("requires Instagram content publishing permission before scheduling", () => {
    expect(
      socialConnectionCanPublish("instagram", [
        "instagram_business_basic",
        "instagram_business_manage_comments",
      ]),
    ).toBe(false);
    expect(socialConnectionCanPublish("instagram", ["instagram_business_content_publish"])).toBe(
      true,
    );
    expect(socialConnectionCanPublish("youtube", [])).toBe(true);
  });

  it("backs publishing retries off exponentially and caps them at six hours", () => {
    expect(socialRetryDelaySeconds(1, null, () => 1)).toBe(30);
    expect(socialRetryDelaySeconds(2, null, () => 1)).toBe(60);
    expect(socialRetryDelaySeconds(3, null, () => 1)).toBe(120);
    expect(socialRetryDelaySeconds(20, null, () => 1)).toBe(21_600);
    expect(socialRetryDelaySeconds(2, 300, () => 0)).toBe(300);
    expect(socialRetryDelaySeconds(2, null, () => 0)).toBe(30);
  });

  it("parses delta and HTTP-date Retry-After values safely", () => {
    expect(parseRetryAfterSeconds("90")).toBe(90);
    expect(parseRetryAfterSeconds("not-a-date")).toBeNull();
    expect(parseRetryAfterSeconds(null)).toBeNull();
    expect(parseRetryAfterSeconds("Wed, 02 Aug 2026 12:01:30 GMT", Date.UTC(2026, 7, 2, 12))).toBe(
      90,
    );
  });

  it("derives every aggregate post state without leaving terminal targets publishing", () => {
    expect(deriveSocialPostStatus([])).toBeNull();
    expect(deriveSocialPostStatus(["published", "published"])).toBe("published");
    expect(deriveSocialPostStatus(["failed", "failed"])).toBe("failed");
    expect(deriveSocialPostStatus(["cancelled", "cancelled"])).toBe("cancelled");
    expect(deriveSocialPostStatus(["published", "failed"])).toBe("partially_failed");
    expect(deriveSocialPostStatus(["published", "cancelled"])).toBe("partially_failed");
    expect(deriveSocialPostStatus(["failed", "cancelled"])).toBe("failed");
    expect(deriveSocialPostStatus(["queued"])).toBe("publishing");
    expect(deriveSocialPostStatus(["published", "retrying"])).toBe("publishing");
  });

  it("summarizes destination delivery health across every provider", () => {
    const targets: SchedulerPost["targets"] = [
      {
        id: "1",
        connectionId: "1",
        provider: "instagram",
        status: "published",
        remotePostUrl: null,
        errorMessage: null,
        publishedAt: null,
      },
      {
        id: "2",
        connectionId: "2",
        provider: "instagram",
        status: "failed",
        remotePostUrl: null,
        errorMessage: "failed",
        publishedAt: null,
      },
      {
        id: "3",
        connectionId: "3",
        provider: "reddit",
        status: "retrying",
        remotePostUrl: null,
        errorMessage: null,
        publishedAt: null,
      },
      {
        id: "4",
        connectionId: "4",
        provider: "reddit",
        status: "cancelled",
        remotePostUrl: null,
        errorMessage: null,
        publishedAt: null,
      },
    ];
    const summary = summarizeSchedulerOperations([{ targets }]);

    expect(summary).toMatchObject({
      totalTargets: 4,
      publishedTargets: 1,
      failedTargets: 1,
      activeTargets: 1,
      cancelledTargets: 1,
      successRate: 50,
    });
    expect(summary.providers).toEqual([
      {
        provider: "instagram",
        total: 2,
        published: 1,
        failed: 1,
        active: 0,
        cancelled: 0,
        successRate: 50,
      },
      {
        provider: "reddit",
        total: 2,
        published: 0,
        failed: 0,
        active: 1,
        cancelled: 1,
        successRate: null,
      },
    ]);
  });

  it("selects only supported media within the remaining upload limit", () => {
    const files = [
      { type: "image/png", name: "one.png" },
      { type: "text/plain", name: "notes.txt" },
      { type: "video/mp4", name: "two.mp4" },
      { type: "image/jpeg", name: "three.jpg" },
    ];
    const selection = prepareSchedulerMediaFiles(files, 8, 10);

    expect(selection.accepted.map((file) => file.name)).toEqual(["one.png", "two.mp4"]);
    expect(selection.rejectedCount).toBe(1);
    expect(selection.overflowCount).toBe(1);
    expect(files).toHaveLength(4);
  });

  it("derives the strict shared media contract for selected destinations", () => {
    expect(schedulerMediaCompatibility([])).toMatchObject({
      allowedKinds: ["image", "video", "file"],
      maxMedia: 10,
      disabled: false,
    });
    expect(schedulerMediaCompatibility(["instagram", "linkedin"])).toMatchObject({
      allowedKinds: ["image", "video"],
      maxMedia: 10,
      disabled: false,
    });
    expect(schedulerMediaCompatibility(["linkedin"])).toMatchObject({
      allowedKinds: ["image", "video", "file"],
      maxMedia: 20,
      disabled: false,
    });
    expect(schedulerMediaCompatibility(["tiktok", "youtube"])).toMatchObject({
      allowedKinds: ["video"],
      maxMedia: 1,
      disabled: false,
    });
    expect(schedulerMediaCompatibility(["instagram", "twitter"])).toMatchObject({
      allowedKinds: ["image", "video"],
      maxMedia: 4,
      disabled: false,
    });
  });

  it("filters uploads to the shared provider media kind", () => {
    const files = [
      { type: "image/png", name: "one.png" },
      { type: "video/mp4", name: "two.mp4" },
    ];
    const selection = prepareSchedulerMediaFiles(files, 0, 1, ["video"]);

    expect(selection.accepted.map((file) => file.name)).toEqual(["two.mp4"]);
    expect(selection.rejectedCount).toBe(1);
    expect(selection.overflowCount).toBe(0);
  });

  it("accepts videos with empty browser MIME types when the extension is clear", () => {
    const selection = prepareSchedulerMediaFiles(
      [{ type: "", name: "clip.mp4" }],
      0,
      1,
      ["video"],
      ["video/mp4", "video/quicktime", "video/*"],
    );
    expect(selection.accepted.map((file) => file.name)).toEqual(["clip.mp4"]);
    expect(selection.rejectedCount).toBe(0);
  });

  it("accepts convertible image formats for destinations that support images", () => {
    const files = [
      { type: "image/webp", name: "one.webp" },
      { type: "image/png", name: "two.png" },
      { type: "application/pdf", name: "deck.pdf" },
    ];
    const selection = prepareSchedulerMediaFiles(
      files,
      0,
      2,
      ["image"],
      ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"],
    );

    expect(selection.accepted.map((file) => file.name)).toEqual(["one.webp", "two.png"]);
    expect(selection.rejectedCount).toBe(1);
    expect(selection.overflowCount).toBe(0);
  });

  it("accepts PDF uploads for LinkedIn-compatible media kinds", () => {
    const files = [
      { type: "application/pdf", name: "deck.pdf" },
      { type: "image/png", name: "cover.png" },
    ];
    const selection = prepareSchedulerMediaFiles(
      files,
      0,
      2,
      ["image", "video", "file"],
      ["image/jpeg", "image/png", "application/pdf"],
    );
    expect(selection.accepted.map((file) => file.name)).toEqual(["deck.pdf", "cover.png"]);
  });

  it("rejects PDF for Instagram while allowing LinkedIn document posts", () => {
    const media = [
      {
        key: "users/user/file/deck.pdf",
        url: "https://app.test.bento.surf/cdn/users/user/file/deck.pdf",
        name: "deck.pdf",
        mimeType: "application/pdf",
        size: 12_000,
      },
    ];
    expect(validatePostForProviders("PDF carousel", media, ["instagram"])).toMatchObject({
      instagram: expect.stringMatching(/does not accept PDF/i),
    });
    expect(validatePostForProviders("PDF carousel", media, ["linkedin"])).toEqual({});
  });

  it("rejects duplicate publishing destinations before persistence", () => {
    const connectionId = "00000000-0000-4000-8000-000000000001";
    const result = socialPostInputSchema.safeParse({
      body: "A scheduled post",
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      timezone: "UTC",
      connectionIds: [connectionId, connectionId],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "connectionIds")).toBe(true);
    }
  });

  it("accepts a valid Reddit text post", () => {
    expect(
      validatePostForProviders("A useful post for creators", [], ["reddit"], "A clear title", {
        reddit: { community: "creators", kind: "self" },
      }),
    ).toEqual({});
  });

  it("accepts a Reddit link post without requiring duplicate body text", () => {
    expect(
      validatePostForProviders("", [], ["reddit"], "A useful resource", {
        reddit: { community: "r/creators", kind: "link", url: "https://bento.surf" },
      }),
    ).toEqual({});
  });

  it("rejects incomplete or invalid Reddit destinations", () => {
    expect(
      validatePostForProviders("A post", [], ["reddit"], "", {
        reddit: { community: "", kind: "self" },
      }).reddit,
    ).toContain("title");
    expect(
      validatePostForProviders("A post", [], ["reddit"], "A title", {
        reddit: { community: "not valid!", kind: "self" },
      }).reddit,
    ).toContain("community");
    expect(
      validatePostForProviders("", [], ["reddit"], "A title", {
        reddit: { community: "creators", kind: "link", url: "not-a-url" },
      }).reddit,
    ).toContain("valid https:// URL");
  });
});

describe("social post drafts", () => {
  it("allows saving a draft without a publish time", () => {
    expect(
      socialPostInputSchema.parse({
        body: "Draft caption",
        scheduledAt: null,
        connectionIds: ["11111111-1111-1111-1111-111111111111"],
        asDraft: true,
      }).asDraft,
    ).toBe(true);
  });

  it("rejects draft+publishNow combinations", () => {
    expect(() =>
      socialPostInputSchema.parse({
        body: "Nope",
        scheduledAt: null,
        connectionIds: ["11111111-1111-1111-1111-111111111111"],
        asDraft: true,
        publishNow: true,
      }),
    ).toThrow();
  });

  it("allows Instagram carousel media counts up to ten", () => {
    const media = Array.from({ length: 3 }, (_, index) => ({
      ...image,
      key: `users/user/image/${index}.jpg`,
      url: `https://bento.surf/cdn/users/user/image/${index}.jpg`,
    }));
    expect(validatePostForProviders("Carousel", media, ["instagram"])).toEqual({});
  });
});

describe("calendar compose scheduling helpers", () => {
  it("marks today and future days as schedulable, not past days", () => {
    const now = new Date(2026, 7, 13, 15, 0, 0);
    expect(isSchedulableCalendarDay(new Date(2026, 7, 13), now)).toBe(true);
    expect(isSchedulableCalendarDay(new Date(2026, 7, 14), now)).toBe(true);
    expect(isSchedulableCalendarDay(new Date(2026, 7, 12), now)).toBe(false);
  });

  it("prefills noon on future days and clamps past days to the soonest valid time", () => {
    const now = new Date(2026, 7, 13, 10, 0, 0);
    const future = scheduleTimeForDate(new Date(2026, 7, 20), now);
    expect(future).toBe("2026-08-20T12:00");

    const past = scheduleTimeForDate(new Date(2026, 7, 10), now);
    expect(past).toBe(minimumScheduleTime(now));
  });

  it("uses the default near-term time when composing for today", () => {
    const now = new Date(2026, 7, 13, 10, 0, 0);
    expect(scheduleTimeForDate(new Date(2026, 7, 13, 8, 0, 0), now)).toBe(defaultScheduleTime(now));
  });
});
