import { expect, test } from "vitest";
import { detectPlatformFromUrl } from "@/lib/platform-detection";

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
