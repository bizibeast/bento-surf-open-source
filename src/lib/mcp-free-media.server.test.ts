import { beforeEach, describe, expect, it, vi } from "vitest";

const reserveProviderUsage = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./provider-budget.server", async () => ({
  ...(await vi.importActual<typeof import("./provider-budget.server")>("./provider-budget.server")),
  reserveProviderUsage,
}));

import { ProviderBudgetError } from "./provider-budget.server";
import { handleFreeToolMediaRequest } from "./media-tools.server";
import { MEDIA_TOOLS_API_PATH } from "./media-tools";

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
