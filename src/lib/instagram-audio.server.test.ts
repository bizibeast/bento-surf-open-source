import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  plan: vi.fn(),
  rate: vi.fn(),
  decrypt: vi.fn(async () => "server-only-token"),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("./plan.server", () => ({ requirePlanEntitlement: mocks.plan }));
vi.mock("./request-security.server", async () => ({
  ...(await vi.importActual<typeof import("./request-security.server")>(
    "./request-security.server",
  )),
  enforceRequestRateLimit: mocks.rate,
}));
vi.mock("./secret-crypto.server", () => ({
  decryptServerSecret: mocks.decrypt,
  encryptServerSecret: vi.fn(),
}));
import {
  getInstagramAudioCatalogForUser,
  getInstagramAudioCatalogForMcp,
} from "./instagram-audio.server";

const OWNER = "00000000-0000-4000-8000-000000000001";
const CONNECTION = "00000000-0000-4000-8000-000000000002";
let expired = false;
let granted = true;
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  expired = false;
  granted = true;
  mocks.plan.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        filters[key] = value;
        return query;
      },
      maybeSingle: async () => ({
        error: null,
        data:
          filters.user_id !== OWNER || (filters.id ?? filters.connection_id) !== CONNECTION
            ? null
            : table === "social_connections"
              ? { provider_user_id: "1784140001", provider_handle: "creator" }
              : !granted
                ? null
                : {
                    instagram_user_id: "1784140001",
                    access_token: "encrypted",
                    expires_at: expired ? "2000-01-01T00:00:00Z" : null,
                  },
      }),
    };
    return query;
  });
  fetcher = vi.fn(async () =>
    Response.json({
      audio: [
        {
          audio_id: "587784541076604",
          title: "A real catalog result",
          display_artist: "Artist",
          audio_type: "music",
          duration_in_ms: 45000,
          download_url: "https://scontent.cdninstagram.com/preview.m4a",
          cover_artwork_thumbnail_uri: "https://scontent.cdninstagram.com/cover.jpg",
          on_platform_audio_preview_link: "https://www.instagram.com/reels/audio/587784541076604/",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());

it("reads Meta's trending catalog for the owned account without a search query or token in results", async () => {
  const result = await getInstagramAudioCatalogForUser(OWNER, { connectionId: CONNECTION });
  const [raw, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  const url = new URL(raw);
  expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v25.0/ig_audio");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    audio_type: "music",
    user_id: "1784140001",
  });
  expect(init.headers).toMatchObject({ Authorization: "Bearer server-only-token" });
  expect(result).toMatchObject({
    connected: true,
    mode: "trending",
    tracks: [
      {
        id: "587784541076604",
        title: "A real catalog result",
        creator: "Artist",
        durationMs: 45000,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("server-only-token");
  expect(mocks.rate).toHaveBeenCalledWith("EXPENSIVE_API_RATE_LIMITER", "instagram-audio", OWNER);
});

it("searches original sounds with a normalized query rather than calling those results trending", async () => {
  const result = await getInstagramAudioCatalogForUser(OWNER, {
    connectionId: CONNECTION,
    type: "original_sound",
    query: "  building  ",
  });
  expect(new URL(fetcher.mock.calls[0][0]).searchParams.get("search_query")).toBe("building");
  expect(new URL(fetcher.mock.calls[0][0]).searchParams.get("audio_type")).toBe("original_sound");
  expect(result.mode).toBe("search");
});

it.each(["missing", "expired"])(
  "returns a connection step for a %s grant without contacting Meta",
  async (reason) => {
    granted = reason !== "missing";
    expired = reason === "expired";
    const result = await getInstagramAudioCatalogForUser(OWNER, { connectionId: CONNECTION });
    expect(result).toMatchObject({ connected: false, tracks: [] });
    expect(result.nextStep).toMatch(/Facebook/);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("rejects a foreign account before decrypting or contacting Meta", async () => {
  await expect(
    getInstagramAudioCatalogForUser("00000000-0000-4000-8000-000000000099", {
      connectionId: CONNECTION,
    }),
  ).rejects.toThrow(/Connect the Instagram account/);
  expect(mocks.decrypt).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it("enforces the MCP entitlement before a catalog read", async () => {
  mocks.plan.mockRejectedValueOnce(new Error("Plan denied"));
  await expect(getInstagramAudioCatalogForMcp(OWNER, { connectionId: CONNECTION })).rejects.toThrow(
    "Plan denied",
  );
  expect(mocks.plan).toHaveBeenCalledWith(OWNER, "mcpSocialAutomation", expect.any(String));
  expect(mocks.from).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it("fails safely on Meta permission errors without leaking provider data or retrying", async () => {
  fetcher.mockResolvedValueOnce(
    Response.json({ error: { message: "server-only-token denied" } }, { status: 403 }),
  );
  await expect(
    getInstagramAudioCatalogForUser(OWNER, { connectionId: CONNECTION }),
  ).rejects.toThrow(/Meta could not authorize/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects invalid connection IDs and oversized queries before a provider call", async () => {
  await expect(
    getInstagramAudioCatalogForUser(OWNER, { connectionId: "not-a-uuid" }),
  ).rejects.toThrow();
  await expect(
    getInstagramAudioCatalogForUser(OWNER, { connectionId: CONNECTION, query: "x".repeat(101) }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
