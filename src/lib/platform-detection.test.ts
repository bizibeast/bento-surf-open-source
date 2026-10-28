import { expect, test } from "vitest";
import {
  detectPlatformFromUrl,
  normalizeStoredSocialLink,
  socialProfileHref,
} from "@/lib/platform-detection";

test("detects a supported social profile URL", () => {
  const result = detectPlatformFromUrl("https://www.instagram.com/bento.surf/");

  expect(result?.platform.key).toBe("instagram");
  expect(result?.handle).toBe("bento.surf");
  expect(result?.hostname).toBe("instagram.com");
});

test("rejects malformed and unsupported URLs", () => {
  expect(detectPlatformFromUrl("not a url")).toBeNull();
  expect(detectPlatformFromUrl("https://example.com/bento")).toBeNull();
});

test("stores a profile handle and switches platform when a pasted URL belongs elsewhere", () => {
  expect(normalizeStoredSocialLink("github", "https://github.com/rish106-hub")).toEqual({
    platform: "github",
    handle: "rish106-hub",
  });
  expect(normalizeStoredSocialLink("instagram", "https://x.com/lotusW3PM")).toEqual({
    platform: "twitter",
    handle: "lotusW3PM",
  });
  expect(normalizeStoredSocialLink("dribbble", "http://portfolio.example/work")).toEqual({
    platform: "dribbble",
    handle: "http://portfolio.example/work",
  });
  expect(normalizeStoredSocialLink("instagram", "@bento.surf")).toEqual({
    platform: "instagram",
    handle: "bento.surf",
  });
});

test("keeps profile URLs that a handle cannot rebuild", () => {
  const preserved = [
    ["facebook", "https://www.facebook.com/profile.php?id=123"],
    ["facebook", "https://www.facebook.com/groups/foo"],
    ["discord", "https://discord.com/invite/abc"],
    ["medium", "https://medium.com/some-publication"],
    ["linkedin", "https://www.linkedin.com/company/bento"],
    ["linkedin", "https://www.linkedin.com/school/stanford"],
    ["youtube", "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw"],
    ["reddit", "https://www.reddit.com/u/spez"],
  ] as const;

  for (const [platform, url] of preserved) {
    const stored = normalizeStoredSocialLink(platform, url);
    expect(stored).toEqual({ platform, handle: url });
    expect(socialProfileHref(stored.platform, stored.handle)).toBe(url);
    expect(normalizeStoredSocialLink(stored.platform, stored.handle)).toEqual(stored);
  }
});

test("is idempotent and leaves a stored full URL unchanged on a later edit", () => {
  const url = "https://www.facebook.com/profile.php?id=123";
  const edited = normalizeStoredSocialLink("facebook", url);
  expect(edited.handle).toBe(url);
  expect(normalizeStoredSocialLink(edited.platform, edited.handle)).toEqual(edited);

  const shortened = normalizeStoredSocialLink("github", "https://github.com/rish106-hub/");
  expect(shortened).toEqual({ platform: "github", handle: "rish106-hub" });
  expect(normalizeStoredSocialLink(shortened.platform, shortened.handle)).toEqual(shortened);
});

test("keeps dotted names as handles, including a second save", () => {
  const cases = [
    ["instagram", "bento.surf", "bento.surf"],
    ["instagram", "john.doe", "john.doe"],
    ["tiktok", "khaby.lame", "khaby.lame"],
    ["github", "octo.cat", "octo.cat"],
    ["instagram", "@Bento.Surf", "Bento.Surf"],
  ] as const;

  for (const [platform, input, handle] of cases) {
    const once = normalizeStoredSocialLink(platform, input);
    expect(once).toEqual({ platform, handle });
    expect(normalizeStoredSocialLink(once.platform, once.handle)).toEqual(once);
  }

  const pasted = normalizeStoredSocialLink("instagram", "instagram.com/bento.surf");
  expect(pasted).toEqual({ platform: "instagram", handle: "bento.surf" });
  expect(normalizeStoredSocialLink(pasted.platform, pasted.handle)).toEqual(pasted);
});

test("drops a broken local URL, ignores tracking params, and accepts twitter.com", () => {
  expect(normalizeStoredSocialLink("instagram", "localhost:8080/x")).toEqual({
    platform: "instagram",
    handle: "",
  });
  expect(normalizeStoredSocialLink("instagram", "http://localhost:8080/x")).toEqual({
    platform: "instagram",
    handle: "",
  });
  expect(
    normalizeStoredSocialLink("instagram", "https://www.instagram.com/bento.surf?hl=en"),
  ).toEqual({ platform: "instagram", handle: "bento.surf" });
  expect(
    normalizeStoredSocialLink("twitter", "https://x.com/bentosurf?s=21&utm_source=share"),
  ).toEqual({ platform: "twitter", handle: "bentosurf" });
  const twitter = normalizeStoredSocialLink("instagram", "https://twitter.com/bentosurf");
  expect(twitter).toEqual({ platform: "twitter", handle: "bentosurf" });
  expect(normalizeStoredSocialLink(twitter.platform, twitter.handle)).toEqual(twitter);
});

test("renders a stored full URL instead of prefixing the platform base", () => {
  expect(socialProfileHref("instagram", "https://x.com/lotusW3PM")).toBe("https://x.com/lotusW3PM");
  expect(socialProfileHref("instagram", "bento.surf")).toBe("https://www.instagram.com/bento.surf");
  expect(socialProfileHref("github", "octocat", "https://github.com/octocat")).toBe(
    "https://github.com/octocat",
  );
});
