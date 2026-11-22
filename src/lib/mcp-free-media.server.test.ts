import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reserveProviderUsage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./provider-budget.server", async () => ({
  ...(await vi.importActual<typeof import("./provider-budget.server")>("./provider-budget.server")),
  reserveProviderUsage,
}));

import { ProviderBudgetError } from "./provider-budget.server";
import { handleFreeToolMediaRequest } from "./media-tools.server";
import { isMediaToolDownloadResult, MEDIA_TOOLS_API_PATH } from "./media-tools";
import { runMcpFreeMediaTool } from "./mcp-free-tools.server";
import mediaResolver from "../media-resolver.worker";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const cobaltOrigin = "https://cobalt.bento.surf";
const request = () =>
  new Request(`https://bento.surf${MEDIA_TOOLS_API_PATH}`, {
    method: "POST",
    headers: { origin: "https://bento.surf", "content-type": "application/json" },
    body: JSON.stringify({
      toolSlug: "youtube-video-downloader",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    }),
  });

beforeEach(() => reserveProviderUsage.mockReset().mockResolvedValue(undefined));

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["https://linkedin.com/posts/team_activity-1234567890123456789-post", "document", "pdf"],
  ["https://in.pinterest.com/pin/1234567890/", "image", "jpg"],
] as const)(
  "runs a signed %s file through the actual MCP runner and gateway",
  async (url, mediaType, extension) => {
    const secret = "a-long-random-shared-secret-used-only-by-tests";
    const limit = vi.fn(async () => ({ success: true }));
    const docManifest = "https://dms.licdn.com/dms/document/config";
    const doc = "https://media.licdn.com/dms/document/report.pdf";
    const photo = "https://i.pinimg.com/originals/ab/cd/ef/photo.jpg";
    vi.stubGlobal("__env__", {
      APP_ENV: "staging",
      COBALT_API_URL: cobaltOrigin,
      COBALT_API_KEY: secret,
      FREE_TOOLS_MEDIA_RATE_LIMITER: { limit },
    });
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      const target = new URL(input);
      if (target.origin === cobaltOrigin) {
        return mediaResolver.fetch(new Request(target, init), { RESOLVER_SHARED_SECRET: secret });
      }
      if (target.hostname === "www.linkedin.com") {
        const config = JSON.stringify({ doc: { manifestUrl: docManifest } }).replaceAll(
          '"',
          "&quot;",
        );
        return new Response(
          `<article data-activity-urn="urn:li:activity:1234567890123456789"><div data-native-document-config="${config}"></div></article>`,
          {
            headers: { "content-type": "text/html" },
          },
        );
      }
      if (target.href === docManifest) return Response.json({ transcribedDocumentUrl: doc });
      if (target.href === doc)
        return new Response(new TextEncoder().encode("%PDF-1.7\n%\n1 0 obj\n"));
      if (target.hostname === "www.pinterest.com")
        return Response.json({ resource_response: { data: { images: { orig: { url: photo } } } } });
      if (target.href === photo)
        return new Response(
          Uint8Array.of(255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1),
        );
      throw new Error(`unexpected fetch: ${target}`);
    });

    const result = await runMcpFreeMediaTool(workspaceId, {
      toolSlug: "social-media-downloader",
      url,
      rightsConfirmed: true,
    });
    expect(isMediaToolDownloadResult(result)).toBe(true);
    expect(result).toMatchObject({
      items: [
        {
          mediaType,
          url: expect.stringContaining("/public-media?"),
          filename: expect.stringMatching(`\\.${extension}$`),
        },
      ],
    });
    expect(limit).toHaveBeenCalledWith({ key: `free-tool-media:mcp:${workspaceId}` });
    expect(reserveProviderUsage).toHaveBeenCalledExactlyOnceWith("mcp_media_resolutions", 1, {
      workspaceId,
    });
  },
);

describe("MCP public-media resolution budget", () => {
  it("checks the owned workspace's rate and global budget before Cobalt", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "tunnel",
        url: `${cobaltOrigin}/tunnel/short-lived-capability`,
        filename: "video.mp4",
      }),
    );
    const response = await handleFreeToolMediaRequest(
      request(),
      {
        APP_ENV: "production",
        COBALT_API_URL: cobaltOrigin,
        COBALT_API_KEY: "test-only-key",
        FREE_TOOLS_MEDIA_RATE_LIMITER: { limit },
      },
      { trustedMcpWorkspaceId: workspaceId, fetcher },
    );
    expect(response?.status).toBe(200);
    expect(limit).toHaveBeenCalledWith({ key: `free-tool-media:mcp:${workspaceId}` });
    expect(reserveProviderUsage).toHaveBeenCalledExactlyOnceWith("mcp_media_resolutions", 1, {
      workspaceId,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("denies a paused or exhausted budget without touching the provider", async () => {
    reserveProviderUsage.mockRejectedValueOnce(new ProviderBudgetError("mcp_media_resolutions"));
    const fetcher = vi.fn<typeof fetch>();
    const response = await handleFreeToolMediaRequest(
      request(),
      {
        APP_ENV: "production",
        COBALT_API_URL: cobaltOrigin,
        COBALT_API_KEY: "test-only-key",
        FREE_TOOLS_MEDIA_RATE_LIMITER: { limit: async () => ({ success: true }) },
      },
      { trustedMcpWorkspaceId: workspaceId, fetcher },
    );
    expect(response?.status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
