import { describe, expect, it } from "vitest";
import { mediaPreviewUrl } from "./media-variants";

describe("mediaPreviewUrl", () => {
  it("requests a sized preview for Bento user media", () => {
    expect(mediaPreviewUrl("http://localhost:8080/cdn/users/123/image/photo.png", 640)).toBe(
      "http://localhost:8080/cdn/users/123/image/photo.png?w=640",
    );
    expect(mediaPreviewUrl("/cdn/users/123/image/photo.png", 320)).toBe(
      "/cdn/users/123/image/photo.png?w=320",
    );
  });

  it("preserves external and non-user media URLs", () => {
    expect(mediaPreviewUrl("https://example.com/photo.png", 640)).toBe(
      "https://example.com/photo.png",
    );
    expect(mediaPreviewUrl("https://bento.surf/cdn/cache/social/photo.png", 640)).toBe(
      "https://bento.surf/cdn/cache/social/photo.png",
    );
  });
});
