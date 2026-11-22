import { describe, expect, it } from "vitest";
import { avatarDeliveryUrl, mediaPreviewUrl } from "./media-variants";

describe("mediaPreviewUrl", () => {
  it("requests a sized preview for Bento user media", () => {
    expect(mediaPreviewUrl("http://localhost:8080/cdn/users/123/image/photo.png", 640)).toBe(
      "/cdn/users/123/image/photo.png?w=640",
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

  it("serves avatars through a resized URL", () => {
    expect(mediaPreviewUrl("http://localhost:8080/cdn/avatars/user/avatar.png", 512)).toBe(
      "/cdn/avatars/user/avatar.png?w=512",
    );
    expect(
      avatarDeliveryUrl(
        "https://project.supabase.co/storage/v1/object/public/avatars/user/photo.png",
      ),
    ).toBe(
      "/api/image?w=512&src=https%3A%2F%2Fproject.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Favatars%2Fuser%2Fphoto.png",
    );
    expect(avatarDeliveryUrl("https://cdn.bento.surf/avatar.webp")).toBe(
      "https://cdn.bento.surf/avatar.webp",
    );
  });

  it("rewrites legacy localhost CDN URLs onto the same-origin media path", () => {
    expect(mediaPreviewUrl("http://localhost:8080/cdn/avatars/user/avatar.png", 512)).toBe(
      "/cdn/avatars/user/avatar.png?w=512",
    );
    expect(avatarDeliveryUrl("http://127.0.0.1:8080/cdn/avatars/user/avatar.png")).toBe(
      "/cdn/avatars/user/avatar.png?w=512",
    );
    expect(avatarDeliveryUrl("http://[::1]:8080/cdn/avatars/user/avatar.png")).toBe(
      "/cdn/avatars/user/avatar.png?w=512",
    );
    expect(mediaPreviewUrl("https://external.example/cdn/avatars/user/avatar.png", 512)).toBe(
      "https://external.example/cdn/avatars/user/avatar.png",
    );
  });
});
