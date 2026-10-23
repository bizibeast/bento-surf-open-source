import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  prefs: vi.fn(),
  resolve: vi.fn(),
  register: vi.fn(),
  head: vi.fn(),
  get: vi.fn(),
  store: vi.fn(),
  load: vi.fn(),
  mutate: vi.fn(),
  moderate: vi.fn(),
  access: vi.fn(),
  update: vi.fn(),
  fetch: vi.fn(),
  capture: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: m.rpc, from: m.from },
}));
vi.mock("./content-agent-identity.server", () => ({
  getContentAgentPreferencesForWorkspace: m.prefs,
}));
vi.mock("./content-agent-media.server", () => ({
  resolveOwnedAgentMedia: m.resolve,
  registerAgentMedia: m.register,
}));
vi.mock("./r2-storage.server", () => ({ getMediaBucket: () => ({ head: m.head, get: m.get }) }));
vi.mock("./content-media.server", () => ({
  storeGeneratedContentMedia: m.store,
  importedMediaType: (bytes: Uint8Array, type: string) =>
    bytes[0] === 255 && bytes[1] === 216 && type === "image/jpeg"
      ? { mimeType: type, extension: "jpg" }
      : null,
}));
vi.mock("./content-agent.actions", () => ({
  loadAssistantResult: m.load,
  mutateAgentDraft: m.mutate,
}));
vi.mock("./ai-json.server", () => ({
  runAiJson: m.moderate,
  decodeAiJsonResponse: (v: unknown) => v,
}));
vi.mock("./posthog.server", () => ({ captureServerEvent: m.capture }));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: m.access }));
import {
  imageProviderAvailable,
  parseImageCompletion,
  submitApiMartImage,
  downloadApiMartImage,
  generateDraftImage,
  processImageJob,
  enqueueSavedDraftImages,
  selectReferencePhotos,
  reserveImageGeneration,
  attachDraftImage,
  getDraftImageState,
  validateReferenceSelection,
  clearDraftBackgrounds,
} from "./content-agent-images.server";
const prefs = {
  generate_images: true,
  use_face_references: false,
  reference_photo_ids: [] as string[],
};
const ref = { messageId: "message", cardId: "draft", revision: 0 };
const card = {
  type: "draft",
  cardId: "draft",
  format: "carousel",
  platform: "instagram",
  visualBrief: "A tree",
  body: "Caption",
  mediaIds: [],
};
const baseJob = {
  id: "job",
  user_id: "owner",
  status: "submitting",
  message_id: "message",
  card_id: "draft",
  draft_revision: 0,
  prompt: "A tree",
  reference_ids: [],
  created_at: "2026-10-11T00:00:00Z",
  lease_key: "lease",
  task_id: "task-1",
};
let updates: Record<string, unknown>[];
beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  vi.stubEnv("APIMART_API_KEY", "test-key");
  vi.stubEnv("CONTENT_AGENT_IMAGES_ENABLED", "true");
  vi.stubEnv("CONTENT_AGENT_IMAGES_WORKSPACES", "owner");
  vi.stubGlobal("fetch", m.fetch);
  m.prefs.mockResolvedValue({ ...prefs });
  m.load.mockResolvedValue({ result: { cards: [{ ...card }], draftStates: {} } });
  m.moderate.mockResolvedValue({ value: { allowed: true } });
  m.head.mockResolvedValue(null);
  m.store.mockResolvedValue(undefined);
  m.mutate.mockResolvedValue({ revision: 1 });
  m.register.mockResolvedValue("owned-image");
  m.resolve.mockResolvedValue([
    {
      key: "users/owner/photo.jpg",
      url: "https://bento.surf/photo.jpg",
      mimeType: "image/jpeg",
      size: 4,
    },
  ]);
  m.get.mockImplementation(async () => ({
    size: 4,
    body: new Response(new Uint8Array([255, 216, 255, 217])).body,
  }));
  m.rpc.mockImplementation(async (name: string) => ({
    data:
      name === "claim_content_agent_image"
        ? { ...baseJob }
        : name === "complete_content_agent_image"
          ? { ...baseJob, status: "storage_pending", completed_at: "2026-10-12T00:00:00Z" }
          : { id: "job" },
    error: null,
  }));
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({ data: { id: "photo", media_type: "image" }, error: null }),
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      return query;
    },
    then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
  };
  m.from.mockReturnValue(query);
});
describe("optional image provider contract", () => {
  it("is unavailable by default and resolves credentials at call time", () => {
    expect(imageProviderAvailable("owner", {})).toBe(false);
    expect(
      imageProviderAvailable("owner", {
        CONTENT_AGENT_IMAGES_ENABLED: "true",
        CONTENT_AGENT_IMAGES_WORKSPACES: "owner",
        APIMART_API_KEY: "test",
      }),
    ).toBe(true);
    vi.stubEnv("APIMART_API_KEY", "");
    expect(imageProviderAvailable("owner")).toBe(false);
  });
  it("submits exactly one documented output without sending reference URLs when absent", async () => {
    m.fetch.mockResolvedValue(
      Response.json({ code: 200, data: [{ status: "submitted", task_id: "task-1" }] }),
    );
    expect(await submitApiMartImage("key", "A tree", [], m.fetch)).toBe("task-1");
    expect(m.fetch.mock.calls[0][1].redirect).toBe("manual");
    const body = JSON.parse(m.fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ n: 1, model: "gemini-3.1-flash-image-preview", resolution: "1K" });
    expect(body.image_urls).toBeUndefined();
  });
  it("reads documented URL arrays and uses trusted completion seconds", () => {
    const value = {
      status: "completed",
      completed: 1791763200,
      result: { images: [{ url: ["https://upload.apimart.ai/one.png"] }] },
    };
    expect(
      parseImageCompletion(value, "2026-10-11T00:00:00Z", new Date("2026-10-12T00:00:00Z")),
    ).toEqual({
      urls: ["https://upload.apimart.ai/one.png"],
      completedAt: "2026-10-12T00:00:00.000Z",
      count: 1,
    });
    expect(
      parseImageCompletion(
        { ...value, completed: 9999999999 },
        "2026-10-11T00:00:00Z",
        new Date("2026-10-12T00:00:00Z"),
      ),
    ).toHaveProperty("completedAt", "2026-10-12T00:00:00.000Z");
  });
  it("rejects arbitrary hosts and redirect escape without credential forwarding", async () => {
    await expect(downloadApiMartImage("https://attacker.invalid/a.png", m.fetch)).rejects.toThrow(
      "host",
    );
    expect(m.fetch).not.toHaveBeenCalled();
    m.fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://attacker.invalid/a.jpg" } }),
    );
    await expect(downloadApiMartImage("https://upload.apimart.ai/a.jpg", m.fetch)).rejects.toThrow(
      "host",
    );
    expect(m.fetch.mock.calls[0][1].headers).toBeUndefined();
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });
  it("checks bytes and bounds downloads", async () => {
    m.fetch.mockResolvedValue(
      new Response("not-image", { headers: { "content-type": "image/jpeg" } }),
    );
    await expect(downloadApiMartImage("https://upload.apimart.ai/a.jpg", m.fetch)).rejects.toThrow(
      "bytes",
    );
    m.fetch.mockResolvedValue(
      new Response("x", {
        headers: { "content-length": "999999999", "content-type": "image/jpeg" },
      }),
    );
    await expect(
      downloadApiMartImage("https://upload.apimart.ai/a.jpg", m.fetch),
    ).rejects.toThrow();
  });
  it("keeps reference consent separate and rejects unreviewed or foreign IDs", async () => {
    await expect(
      generateDraftImage({
        userId: "owner",
        draftRef: ref,
        referenceIds: ["foreign"],
        requestKey: "one",
      }),
    ).rejects.toThrow("reference");
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.get).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
    m.prefs.mockResolvedValue({
      ...prefs,
      use_face_references: true,
      reference_photo_ids: ["photo"],
    });
    m.resolve.mockRejectedValue(new Error("foreign media"));
    await expect(
      generateDraftImage({
        userId: "owner",
        draftRef: ref,
        referenceIds: ["photo"],
        requestKey: "one",
      }),
    ).rejects.toThrow("foreign");
  });
  it("reserves without doing a paid call and passes the same idempotency key", async () => {
    await generateDraftImage({
      userId: "owner",
      draftRef: ref,
      referenceIds: [],
      requestKey: "stable",
    });
    expect(m.rpc).toHaveBeenCalledWith(
      "reserve_content_agent_image",
      expect.objectContaining({
        p_request_key: "stable",
        p_count: 1,
        p_references: [],
        p_draft: { ...ref, slideIndex: 0 },
      }),
    );
    expect(m.fetch).not.toHaveBeenCalled();
    await reserveImageGeneration({ userId: "owner", requestKey: "stable", count: 1 });
    expect(m.rpc.mock.calls[1][1].p_request_key).toBe("stable");
  });
  it("rechecks generation consent immediately before submission", async () => {
    m.prefs.mockResolvedValue({ ...prefs, generate_images: false });
    await processImageJob("owner", "job");
    expect(m.fetch).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });
  it("never transfers saved face IDs after consent revocation", async () => {
    m.rpc.mockResolvedValue({ data: { ...baseJob, reference_ids: ["photo"] }, error: null });
    await processImageJob("owner", "job");
    expect(m.fetch).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });
  it("persists accepted task before any polling", async () => {
    m.fetch.mockResolvedValue(
      Response.json({ code: 200, data: [{ task_id: "new-task", status: "submitted" }] }),
    );
    await processImageJob("owner", "job");
    expect(m.fetch).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({ status: "submitted", task_id: "new-task" });
  });
  it("retains ambiguous submissions and never blindly retries", async () => {
    m.fetch.mockRejectedValue(new Error("timeout"));
    await processImageJob("owner", "job");
    expect(updates.at(-1)).toMatchObject({ status: "ambiguous" });
    m.rpc.mockResolvedValue({ data: null, error: null });
    await processImageJob("owner", "job");
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });
  it("releases confirmed provider failure", async () => {
    m.rpc.mockResolvedValue({ data: { ...baseJob, status: "submitted" }, error: null });
    m.fetch.mockResolvedValue(Response.json({ code: 200, data: { status: "failed" } }));
    await processImageJob("owner", "job");
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });
  it("charges success before storage failure, without a replacement POST", async () => {
    m.rpc.mockImplementation(async (name: string) => ({
      data: {
        ...baseJob,
        status: name === "claim_content_agent_image" ? "submitted" : "storage_pending",
      },
      error: null,
    }));
    m.fetch.mockImplementation(async (url: string) =>
      url.includes("/v1/tasks/")
        ? Response.json({
            code: 200,
            data: {
              status: "completed",
              completed: 1791763200,
              result: { images: [{ url: ["https://upload.apimart.ai/a.jpg"] }] },
            },
          })
        : new Response(new Uint8Array([255, 216, 255, 217]), {
            headers: { "content-type": "image/jpeg" },
          }),
    );
    m.store.mockRejectedValue(new Error("Storage full: private provider error and source details"));
    await processImageJob("owner", "job");
    expect(m.rpc).toHaveBeenCalledWith(
      "complete_content_agent_image",
      expect.objectContaining({ p_count: 1 }),
    );
    expect(updates.at(-1)).toMatchObject({
      detail: "Storage full: private provider error and source details",
    });
    expect(m.capture).toHaveBeenCalledExactlyOnceWith(
      "owner",
      "content_agent_image",
      { status: "storage_pending", count: 1 },
      expect.anything(),
    );
    expect(m.capture.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.rpc.mock.invocationCallOrder[1],
    );
    expect(m.capture.mock.invocationCallOrder[0]).toBeLessThan(m.store.mock.invocationCallOrder[0]);
    expect(JSON.stringify(m.capture.mock.calls)).not.toMatch(
      /private|provider error|source details|upload\.apimart|A tree/,
    );
    expect(updates.some((p) => p.status === "failed")).toBe(false);
    expect(m.fetch.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });
  it("retrieves accepted output with consent off, records orphaned ownership, and tolerates CAS conflict", async () => {
    vi.stubEnv("CONTENT_AGENT_IMAGES_ENABLED", "false");
    m.prefs.mockResolvedValue({ ...prefs, generate_images: false });
    m.head.mockResolvedValue({ size: 42 });
    m.rpc.mockImplementation(async (name: string) => ({
      data: {
        ...baseJob,
        status: name === "claim_content_agent_image" ? "submitted" : "storage_pending",
        message_id: null,
      },
      error: null,
    }));
    m.fetch.mockResolvedValue(
      Response.json({
        code: 200,
        data: {
          status: "completed",
          completed: 1791763200,
          result: { images: [{ url: ["https://upload.apimart.ai/a.jpg"] }] },
        },
      }),
    );
    await processImageJob("owner", "job");
    expect(m.register).toHaveBeenCalledWith(
      "owner",
      expect.stringContaining("users/owner/"),
      "generated",
      expect.objectContaining({ messageId: null }),
    );
    expect(updates.at(-1)).toMatchObject({ status: "ready", media_id: "owned-image" });
    expect(m.mutate).not.toHaveBeenCalled();
  });
  it("never automatically spends again for a verified text revision, even with a pending parent visual", async () => {
    m.load
      .mockResolvedValueOnce({
        result: {
          cards: [{ ...card, editorial: { revisionOf: { messageId: "parent", cardId: "draft" } } }],
        },
      })
      .mockResolvedValueOnce({ result: { cards: [card] } });
    await enqueueSavedDraftImages("owner", "new-message");
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it("uses owned media for attachments and the guarded background operation", async () => {
    await attachDraftImage("owner", ref, "photo", 1);
    expect(m.resolve).toHaveBeenCalledWith("owner", ["photo"]);
    expect(m.mutate).toHaveBeenCalledWith("owner", ref, "background", {
      mediaIds: ["photo"],
      slideIndex: 1,
    });
  });
  it("never infers a face from captions when vision is disabled", async () => {
    const query = {
      select: () => query,
      eq: () => query,
      in: () => query,
      order: () => query,
      limit: async () => ({
        data: [{ id: "photo", media_type: "image", caption: "my portrait" }],
        error: null,
      }),
      maybeSingle: async () => ({ data: null, error: null }),
    };
    m.from.mockReturnValue(query);
    expect(await selectReferencePhotos("owner")).toEqual([
      { id: "photo", url: "https://bento.surf/photo.jpg", assessment: "manual" },
    ]);
    expect(m.get).not.toHaveBeenCalled();
  });
});

it.each([
  ["2026-10-01T00:01:00Z", "2026-10-01T00:02:00Z", "2026-09-30T23:59:59Z"],
  ["2026-10-31T23:58:00Z", "2026-10-31T23:59:00Z", "2026-11-01T00:00:01Z"],
])(
  "rejects cross-month timestamps outside the actual job interval",
  (created, observed, completion) => {
    expect(
      parseImageCompletion(
        { status: "completed", completed: Date.parse(completion) / 1000, result: { images: [] } },
        created,
        new Date(observed),
      ).completedAt,
    ).toBe(new Date(observed).toISOString());
  },
);

it("follows verified multi-revision ancestry to the original pending visual", async () => {
  m.load
    .mockResolvedValueOnce({
      result: {
        cards: [{ ...card, editorial: { revisionOf: { messageId: "parent", cardId: "draft" } } }],
      },
    })
    .mockResolvedValueOnce({
      result: {
        cards: [{ ...card, editorial: { revisionOf: { messageId: "original", cardId: "draft" } } }],
      },
    })
    .mockResolvedValueOnce({ result: { cards: [card] } });
  const query = {
    select: () => query,
    eq: () => query,
    in: vi.fn(() => query),
    order: () => query,
    limit: async () => ({
      data: [{ id: "pending", status: "submitted", message_id: "original", card_id: "draft" }],
      error: null,
    }),
  };
  m.from.mockReturnValue(query);
  const state = await getDraftImageState("owner", ref);
  expect(state.jobs[0]).toMatchObject({ id: "pending", status: "submitted" });
  expect(query.in).toHaveBeenCalledWith("message_id", ["message", "parent", "original"]);
  expect(m.fetch).not.toHaveBeenCalled();
});
it("bounds actual vision calls and stores only key-bound quality metadata", async () => {
  vi.stubEnv("CONTENT_AGENT_REFERENCE_VISION_ENABLED", "true");
  const vision = vi.fn().mockResolvedValue({ singleFace: true, clear: true });
  vi.stubGlobal("__env__", {
    AI: { run: vision },
    IMAGES: { info: vi.fn().mockResolvedValue({ width: 1024, height: 1024 }) },
    CLOUDFLARE_AI_GATEWAY_ID: "private-vision",
  });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: async () => ({
      data: [
        { id: "a", media_type: "image" },
        { id: "b", media_type: "image" },
        { id: "c", media_type: "image" },
      ],
      error: null,
    }),
    maybeSingle: async () => ({ data: null, error: null }),
    upsert,
  };
  m.from.mockReturnValue(query);
  const photos = await selectReferencePhotos("owner");
  expect(vision).toHaveBeenCalledTimes(2);
  expect(photos.map((p) => p.assessment)).toEqual(["single_face", "single_face", "manual"]);
  expect(vision).toHaveBeenCalledWith(
    "@cf/meta/llama-3.2-11b-vision-instruct",
    expect.objectContaining({
      messages: [
        expect.objectContaining({
          content: [
            expect.objectContaining({ type: "text" }),
            expect.objectContaining({
              type: "image_url",
              image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) },
            }),
          ],
        }),
      ],
    }),
    { gateway: { id: "private-vision", collectLog: false, skipCache: true } },
  );
  expect(upsert).toHaveBeenCalledWith({
    user_id: "owner",
    media_id: "a",
    storage_key: "users/owner/photo.jpg",
    assessment: "single_face",
    width: 1024,
    height: 1024,
  });
  vi.stubEnv("CONTENT_AGENT_REFERENCE_VISION_ENABLED", "false");
  vi.stubGlobal("__env__", undefined);
});

it("retains a known accepted task ID when its first persistence write fails", async () => {
  m.fetch.mockResolvedValue(
    Response.json({ code: 200, data: [{ status: "submitted", task_id: "accepted-known" }] }),
  );
  let writes = 0;
  const query = {
    update: (patch: Record<string, unknown>) => {
      updates.push(patch);
      writes++;
      return query;
    },
    eq: () => query,
    then: (resolve: (v: unknown) => unknown) =>
      resolve({ error: writes === 1 ? { message: "temporary database outage" } : null }),
  };
  m.from.mockReturnValue(query);
  await processImageJob("owner", "job");
  expect(m.fetch).toHaveBeenCalledTimes(1);
  expect(updates).toHaveLength(2);
  expect(updates[1]).toMatchObject({ status: "submitted", task_id: "accepted-known" });
});
it("automatically enqueues a useful saved draft once under its stable initial key and isolates image failures", async () => {
  await enqueueSavedDraftImages("owner", "message");
  expect(m.rpc).toHaveBeenCalledWith(
    "reserve_content_agent_image",
    expect.objectContaining({
      p_request_key: "initial:message:draft",
      p_count: 1,
      p_draft: { ...ref, slideIndex: 0 },
    }),
  );
  m.rpc.mockRejectedValue(new Error("quota exhausted"));
  await expect(enqueueSavedDraftImages("owner", "message")).resolves.toBeUndefined();
});
it("keeps a paid result ready when a newer draft revision prevents automatic attachment", async () => {
  m.head.mockResolvedValue({ size: 42 });
  m.mutate.mockRejectedValue(new Error("Draft changed"));
  m.rpc.mockImplementation(async (name: string) => ({
    data: {
      ...baseJob,
      status: name === "claim_content_agent_image" ? "submitted" : "storage_pending",
      target_slide_index: 2,
    },
    error: null,
  }));
  m.fetch.mockResolvedValue(
    Response.json({
      code: 200,
      data: {
        status: "completed",
        completed: 1791763200,
        result: { images: [{ url: ["https://upload.apimart.ai/a.jpg"] }] },
      },
    }),
  );
  await processImageJob("owner", "job");
  expect(updates.at(-1)).toMatchObject({ status: "ready", media_id: "owned-image" });
  expect(m.mutate).toHaveBeenCalledWith("owner", ref, "background", {
    mediaIds: ["owned-image"],
    slideIndex: 2,
  });
  expect(m.fetch).toHaveBeenCalledTimes(1);
});

it("rejects video-cover references in listing and direct validation while retaining ordinary photo reuse", async () => {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: async () => ({ data: [{ id: "cover", media_type: "thumbnail" }], error: null }),
    maybeSingle: async () => ({ data: { id: "cover", media_type: "thumbnail" }, error: null }),
  };
  m.from.mockReturnValue(query);
  expect(await selectReferencePhotos("owner")).toEqual([]);
  await expect(validateReferenceSelection("owner", ["cover"], true)).rejects.toThrow(
    "video cover or thumbnail",
  );
  expect(await selectReferencePhotos("owner", false)).toHaveLength(1);
});
it("rejects measured low-resolution references before vision and ranks assessed suitable photos first", async () => {
  vi.stubEnv("CONTENT_AGENT_REFERENCE_VISION_ENABLED", "true");
  const vision = vi.fn();
  vi.stubGlobal("__env__", {
    AI: { run: vision },
    IMAGES: { info: vi.fn().mockResolvedValue({ width: 200, height: 180 }) },
  });
  let current = "";
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const query = {
    select: () => query,
    eq: (field: string, value: string) => {
      if (field === "media_id") current = value;
      return query;
    },
    in: () => query,
    order: () => query,
    limit: async () => ({
      data: [
        { id: "tiny", media_type: "image" },
        { id: "manual", media_type: "image" },
        { id: "good", media_type: "image" },
      ],
      error: null,
    }),
    maybeSingle: async () => ({
      data:
        current === "good"
          ? { assessment: "single_face", width: 1024, height: 1024 }
          : current === "manual"
            ? { assessment: "manual" }
            : null,
      error: null,
    }),
    upsert,
  };
  m.from.mockReturnValue(query);
  const photos = await selectReferencePhotos("owner");
  expect(photos.map((p) => p.id)).toEqual(["good", "manual"]);
  expect(vision).not.toHaveBeenCalled();
  expect(upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      media_id: "tiny",
      assessment: "unsuitable",
      width: 200,
      height: 180,
    }),
  );
  vi.stubEnv("CONTENT_AGENT_REFERENCE_VISION_ENABLED", "false");
  vi.stubGlobal("__env__", undefined);
});

it.each([
  [400, "invalid_request_error"],
  [401, "authentication_error"],
  [402, "payment_required"],
  [403, "permission_error"],
  [429, "rate_limit_error"],
])("releases a documented synchronous rejection %s without resubmission", async (status, type) => {
  m.fetch.mockResolvedValue(
    Response.json(
      { error: { code: status, type, message: "provider rejection" } },
      { status: Number(status) },
    ),
  );
  await processImageJob("owner", "job");
  expect(updates.at(-1)).toMatchObject({ status: "failed" });
  expect(m.fetch).toHaveBeenCalledTimes(1);
});
it("keeps malformed rejection and server errors ambiguous", async () => {
  for (const status of [400, 500]) {
    m.fetch.mockResolvedValue(
      Response.json({ error: { code: status, type: "unknown" } }, { status }),
    );
    await processImageJob("owner", "job");
    expect(updates.at(-1)).toMatchObject({ status: "ambiguous" });
  }
});

it("rejects a directly supplied photo already assessed unsuitable", async () => {
  m.from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({
        data:
          table === "creator_content_media"
            ? { id: "photo", media_type: "image" }
            : { assessment: "unsuitable" },
        error: null,
      }),
    };
    return query;
  });
  await expect(validateReferenceSelection("owner", ["photo"], true)).rejects.toThrow(
    "clear single-face photo",
  );
});

it("recovers registration after storage from durable R2 without provider access or another quota charge", async () => {
  const charged = {
    ...baseJob,
    status: "storage_pending",
    completed_at: "2026-10-12T00:00:00Z",
    output_count: 1,
    result_urls: ["https://upload.apimart.ai/a.jpg"],
  };
  m.rpc.mockImplementation(async (name: string) => ({
    data: name === "claim_content_agent_image" ? { ...baseJob, status: "submitted" } : charged,
    error: null,
  }));
  m.fetch.mockImplementation(async (url: string) =>
    url.includes("/v1/tasks/")
      ? Response.json({
          code: 200,
          data: {
            status: "completed",
            completed: 1791763200,
            result: { images: [{ url: charged.result_urls }] },
          },
        })
      : new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: { "content-type": "image/jpeg" },
        }),
  );
  m.register.mockRejectedValueOnce(new Error("Registry temporarily unavailable"));
  await processImageJob("owner", "job");
  expect(m.store).toHaveBeenCalledTimes(1);
  expect(updates.at(-1)).toMatchObject({ detail: "Registry temporarily unavailable" });
  m.rpc.mockResolvedValue({ data: charged, error: null });
  m.head.mockResolvedValue({ size: 42 });
  m.fetch.mockClear();
  m.fetch.mockRejectedValue(new Error("provider unavailable"));
  m.rpc.mockClear();
  vi.stubEnv("APIMART_API_KEY", "");
  await processImageJob("owner", "job");
  expect(m.fetch).not.toHaveBeenCalled();
  expect(m.rpc.mock.calls.map((call) => call[0])).toEqual(["claim_content_agent_image"]);
  expect(updates.at(-1)).toMatchObject({ status: "ready", media_id: "owned-image" });
});
it("downloads a saved completed URL without a provider status call or credential", async () => {
  vi.stubEnv("APIMART_API_KEY", "");
  m.rpc.mockResolvedValue({
    data: {
      ...baseJob,
      status: "storage_pending",
      completed_at: "2026-10-12T00:00:00Z",
      output_count: 1,
      result_urls: ["https://upload.apimart.ai/saved.jpg"],
    },
    error: null,
  });
  m.fetch.mockResolvedValue(
    new Response(new Uint8Array([255, 216, 255, 217]), {
      headers: { "content-type": "image/jpeg" },
    }),
  );
  await processImageJob("owner", "job");
  expect(m.fetch).toHaveBeenCalledTimes(1);
  expect(m.fetch.mock.calls[0][0]).toBe("https://upload.apimart.ai/saved.jpg");
  expect(updates.at(-1)).toMatchObject({ status: "ready" });
});
it("refreshes an expired saved URL once without charging or submitting again", async () => {
  m.rpc.mockResolvedValue({
    data: {
      ...baseJob,
      status: "storage_pending",
      completed_at: "2026-10-12T00:00:00Z",
      output_count: 1,
      result_urls: ["https://upload.apimart.ai/expired.jpg"],
    },
    error: null,
  });
  m.fetch.mockImplementation(async (url: string) =>
    url.includes("expired")
      ? new Response(null, { status: 410 })
      : url.includes("/v1/tasks/")
        ? Response.json({
            code: 200,
            data: {
              status: "completed",
              completed: 1791763200,
              result: { images: [{ url: ["https://upload.apimart.ai/fresh.jpg"] }] },
            },
          })
        : new Response(new Uint8Array([255, 216, 255, 217]), {
            headers: { "content-type": "image/jpeg" },
          }),
  );
  await processImageJob("owner", "job");
  expect(m.fetch.mock.calls.map((call) => call[0])).toEqual([
    "https://upload.apimart.ai/expired.jpg",
    "https://api.apimart.ai/v1/tasks/task-1?language=en",
    "https://upload.apimart.ai/fresh.jpg",
  ]);
  expect(m.rpc).toHaveBeenCalledTimes(1);
  expect(updates.at(-1)).toMatchObject({
    status: "ready",
    result_urls: ["https://upload.apimart.ai/fresh.jpg"],
  });
});
it("returns repair information while preserving ready job previews when several attached images are missing", async () => {
  m.load.mockResolvedValue({
    result: {
      cards: [
        {
          ...card,
          slides: [
            { heading: "Cover", body: "Promise", mediaId: "missing-a" },
            { heading: "Next", body: "Try it", mediaId: "missing-b" },
          ],
        },
      ],
    },
  });
  m.resolve.mockRejectedValue(new Error("Missing"));
  const state = await getDraftImageState("owner", ref);
  expect(state.missingMediaIds).toEqual(["missing-a", "missing-b"]);
  expect(state.assets).toEqual({});
  await clearDraftBackgrounds("owner", ref);
  expect(m.mutate).toHaveBeenCalledWith("owner", ref, "edit", {
    body: "Caption",
    slides: [
      { heading: "Cover", body: "Promise" },
      { heading: "Next", body: "Try it" },
    ],
  });
});

it.each(["scheduled", "published"])(
  "resolves retained owned previews for %s posts without permitting generation or repair",
  async (status) => {
    m.load.mockResolvedValue({
      result: {
        cards: [{ ...card, mediaIds: ["photo"] }],
        draftStates: { draft: { revision: 0, socialPostId: "canonical-post" } },
      },
    });
    const defaultQuery = m.from.getMockImplementation()!;
    m.from.mockImplementation((table: string) => {
      if (table !== "social_posts") return defaultQuery(table);
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { status }, error: null }),
      };
      return query;
    });
    expect((await getDraftImageState("owner", ref)).assets).toEqual({
      photo: "https://bento.surf/photo.jpg",
    });
    expect(m.load).toHaveBeenCalledWith("owner", "message");
    expect(m.resolve).toHaveBeenCalled();
    await expect(
      generateDraftImage({ userId: "owner", draftRef: ref, referenceIds: [], requestKey: "new" }),
    ).rejects.toThrow("already scheduled");
    await expect(clearDraftBackgrounds("owner", ref)).rejects.toThrow("already scheduled");
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.mutate).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
  },
);

it("still requires a retained owned message and current revision to read attachment previews", async () => {
  m.load.mockRejectedValueOnce(new Error("Message unavailable"));
  await expect(getDraftImageState("other-owner", ref)).rejects.toThrow("Message unavailable");
  await expect(getDraftImageState("owner", { ...ref, revision: 1 })).rejects.toThrow(
    "Draft changed",
  );
  expect(m.resolve).not.toHaveBeenCalled();
  expect(m.from).not.toHaveBeenCalled();
});

it("reserves composer images against the same atomic monthly quota", async () => {
  await reserveImageGeneration({
    userId: "owner",
    count: 1,
    requestKey: "scheduler:stable",
    source: "scheduler",
    referenceIds: ["owned"],
    referencesConfirmed: true,
  });
  expect(m.rpc).toHaveBeenCalledWith(
    "reserve_content_agent_image",
    expect.objectContaining({
      p_user_id: "owner",
      p_count: 1,
      p_draft: expect.objectContaining({ source: "scheduler", referencesConfirmed: true }),
      p_references: ["owned"],
    }),
  );
});
it("rejects composer references without per-request permission before provider transfer", async () => {
  m.rpc.mockResolvedValue({
    data: {
      ...baseJob,
      request_source: "scheduler",
      message_id: null,
      reference_ids: ["owned"],
      references_confirmed: false,
    },
    error: null,
  });
  await processImageJob("owner", "job");
  expect(m.fetch).not.toHaveBeenCalled();
  expect(m.load).not.toHaveBeenCalled();
  expect(updates.at(-1)).toMatchObject({ status: "failed" });
});
it("honors image opt-out for composer requests even after a job has been queued", async () => {
  m.rpc.mockResolvedValue({
    data: { ...baseJob, request_source: "scheduler", message_id: null },
    error: null,
  });
  m.prefs.mockResolvedValue({ ...prefs, generate_images: false });
  await processImageJob("owner", "job");
  expect(m.fetch).not.toHaveBeenCalled();
  expect(updates.at(-1)).toMatchObject({ status: "failed" });
});

it("does not submit an image when its draft was rejected during moderation", async () => {
  m.load
    .mockResolvedValueOnce({ result: { cards: [{ ...card }], draftStates: {} } })
    .mockResolvedValue({ result: { cards: [], draftStates: {}, rejectedDraftIds: ["draft"] } });
  await processImageJob("owner", "job");
  expect(m.moderate).toHaveBeenCalledOnce();
  expect(m.fetch).not.toHaveBeenCalled();
  expect(updates.at(-1)).toMatchObject({ status: "failed" });
});

it("rechecks rejection after provider budget reservation before sending an image request", async () => {
  const current = { result: { cards: [{ ...card }], draftStates: {} } };
  m.load
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(current)
    .mockResolvedValue({ result: { cards: [], draftStates: {}, rejectedDraftIds: ["draft"] } });
  await processImageJob("owner", "job");
  expect(m.load).toHaveBeenCalledTimes(3);
  expect(m.fetch).not.toHaveBeenCalled();
  expect(updates.at(-1)).toMatchObject({ status: "failed" });
});
