import { describe, expect, it } from "vitest";
import { sanitizeMcpReadData } from "./mcp-read-results";

describe("MCP readable data", () => {
  it("removes nested credentials and capability URLs without corrupting user text or operational IDs", () => {
    const body = "My API key story: token_hash is a word, not my credential.";
    const data = {
      body,
      id: "opaque-id",
      sourceKey: "source-key",
      fingerprint: "sha256-value",
      expires_at: "2026-10-24",
      media: [{ key: "owner/video.mp4", url: "https://cdn.bento.surf/video.mp4" }],
      grant: { token_hash: "secret-hash", id: "grant-id", revoked_at: null },
      settings: {
        accessToken: "secret",
        refresh_token: "secret",
        client_secret: "secret",
        title: "My token story",
      },
      targets: [
        {
          upload_session_url: "https://upload.example/session",
          remote_post_url: "https://www.instagram.com/reel/123/",
        },
      ],
      thumbnail_url: "https://storage.example/image?X-Amz-Signature=bearer",
      signedUploadUrl: "https://upload.example/capability",
      mediaUrls: ["https://cdn.example/public.jpg", "https://storage.example/private?token=bearer"],
    };
    expect(sanitizeMcpReadData(data)).toEqual({
      body,
      id: "opaque-id",
      sourceKey: "source-key",
      fingerprint: "sha256-value",
      expires_at: "2026-10-24",
      media: [{ key: "owner/video.mp4", url: "https://cdn.bento.surf/video.mp4" }],
      mediaUrls: ["https://cdn.example/public.jpg"],
      grant: { id: "grant-id", revoked_at: null },
      settings: { title: "My token story" },
      targets: [{ remote_post_url: "https://www.instagram.com/reel/123/" }],
    });
    expect(data.grant.token_hash).toBe("secret-hash");
  });
});
