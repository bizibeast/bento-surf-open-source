/* eslint-disable @typescript-eslint/no-explicit-any -- Capture the heterogeneous MCP registration boundary. */
import { expect, it, vi } from "vitest";
import { createBentoAppTools, defaultBentoMcpOperations } from "./mcp.server";
import { chatGptOperations, registerChatGptTools } from "./mcp.chatgpt.server";
import { socialPostInputSchema } from "./social-scheduler";
import { buildInstagramMediaParams } from "./social-publisher.server";

const OWNER = "00000000-0000-4000-8000-000000000001";
const CONNECTION = "00000000-0000-4000-8000-000000000002";
const FOREIGN = "00000000-0000-4000-8000-000000000003";
const media = {
  key: "image/owner/reel.mp4",
  url: "https://cdn.bento.surf/reel.mp4",
  name: "reel.mp4",
  mimeType: "video/mp4",
  size: 10000,
};
const catalogAudio = {
  sourceKey: media.key,
  connectionId: CONNECTION,
  audioId: "587784541076604",
  title: "Track",
  creator: "Artist",
  trackVolume: 25,
  originalVolume: 100,
};

it("exposes scoped audio discovery in Benny's real registry and advertises typed publishing selection", async () => {
  const read = vi.fn(async () => ({
    connected: true as const,
    connectionId: CONNECTION,
    type: "music" as const,
    query: "",
    observedAt: "2026-11-22T00:00:00Z",
    limitations: [],
    nextStep: null,
    mode: "trending" as const,
    tracks: [
      {
        id: "587784541076604",
        title: "Track",
        creator: "Artist",
        artworkUrl: null,
        previewUrl: null,
        instagramUrl: null,
        durationMs: 45000,
      },
    ],
  }));
  const tools = createBentoAppTools(
    {
      userId: OWNER,
      accessToken: "test",
      supabase: {} as import("./mcp.creator-ops.server").CreatorMcpContext["supabase"],
    },
    "https://app.test.bento.surf",
    {
      ...defaultBentoMcpOperations,
      getInstagramAudioCatalogForMcp: read,
    },
  );
  const tool = tools.get("get_instagram_audio_catalog");
  expect(tool).toBeDefined();
  expect(tool!.readOnly).toBe(true);
  const result = await tool!.execute({ connectionId: CONNECTION });
  expect(result.structuredContent).toMatchObject({
    workspaceId: OWNER,
    catalog: { connected: true, tracks: [{ id: "587784541076604" }] },
  });
  await expect(tool!.execute({ workspaceId: FOREIGN, connectionId: CONNECTION })).rejects.toThrow(
    /Workspace/,
  );
  expect(read).toHaveBeenCalledTimes(1);
  const input = tools.get("create_social_post")!.inputSchema;
  expect(
    input.parse({
      body: "Hello",
      connectionIds: [CONNECTION],
      media: [media],
      mode: "draft",
      providerSettings: { instagram: { catalogAudio } },
    }),
  ).toMatchObject({ providerSettings: { instagram: { catalogAudio } } });
  expect(
    input.safeParse({
      body: "Hello",
      connectionIds: [CONNECTION],
      mode: "draft",
      providerSettings: { instagram: { catalogAudio: { ...catalogAudio, trackVolume: 101 } } },
    }).success,
  ).toBe(false);
  const saved = socialPostInputSchema.parse({
    body: "Hello",
    scheduledAt: null,
    asDraft: true,
    connectionIds: [CONNECTION],
    media: [media],
    providerSettings: { instagram: { catalogAudio } },
  });
  expect(
    JSON.parse(
      buildInstagramMediaParams(saved.body, saved.media[0], saved.providerSettings.instagram).get(
        "audio_configuration",
      )!,
    ),
  ).toEqual({ audio_id: "587784541076604", audio_volume: 25, video_volume: 100 });
});

it("keeps a catalog selection tied to one video and the selected Instagram account", () => {
  const base = {
    body: "Hello",
    scheduledAt: null,
    asDraft: true,
    connectionIds: [CONNECTION],
    media: [media],
    providerSettings: { instagram: { catalogAudio } },
  };
  for (const invalid of [
    { ...base, connectionIds: [FOREIGN] },
    { ...base, media: [{ ...media, key: "different-video" }] },
    { ...base, media: [{ ...media, mimeType: "image/jpeg" }] },
    { ...base, media: [media, { ...media, key: "another-video" }] },
  ])
    expect(socialPostInputSchema.safeParse(invalid).success).toBe(false);
});

it("lets ChatGPT discover audio and retain the chosen track through its strict draft, schedule and update schemas", async () => {
  const entries = new Map<string, { config: any; execute: (input: any) => Promise<any> }>();
  const save = vi.fn(async (_owner, input) => ({ id: "saved", settings: input.providerSettings }));
  const ops = chatGptOperations({
    ...defaultBentoMcpOperations,
    resolveMcpWorkspaceId: async (_owner, requested) => {
      if (requested && requested !== OWNER) throw Error("Workspace is unavailable");
      return OWNER;
    },
    getInstagramAudioCatalogForMcp: async () => ({
      connected: true,
      connectionId: CONNECTION,
      type: "music",
      query: "",
      mode: "trending",
      observedAt: "2026-11-22T00:00:00Z",
      limitations: [],
      nextStep: null,
      tracks: [],
    }),
    saveSocialPostForUser: save,
  });
  registerChatGptTools(
    {
      registerTool(name: string, config: any, execute: any) {
        entries.set(name, { config, execute });
      },
    } as any,
    { token: "test", clientId: "test", scopes: [], extra: { userId: OWNER } },
    "https://app.test.bento.surf",
    ops,
    () => ({ userId: OWNER }) as any,
  );
  const read = entries.get("get_instagram_audio_catalog");
  expect(read).toBeDefined();
  const response = await read!.execute(
    read!.config.inputSchema.parse({ connectionId: CONNECTION }),
  );
  expect(response.structuredContent).toMatchObject({ catalog: { mode: "trending" } });
  for (const name of ["draft_social_post", "schedule_social_post", "update_social_post"]) {
    const entry = entries.get(name)!;
    const args = entry.config.inputSchema.parse({
      id: FOREIGN,
      body: "Hello",
      connectionIds: [CONNECTION],
      media: [media],
      scheduledAt: "2030-01-01T00:00:00Z",
      providerSettings: { instagram: { catalogAudio } },
    });
    const result = await entry.execute(args);
    expect(result.structuredContent.post.settings.instagram.catalogAudio).toEqual(catalogAudio);
  }
  expect(save).toHaveBeenCalledTimes(3);
});
