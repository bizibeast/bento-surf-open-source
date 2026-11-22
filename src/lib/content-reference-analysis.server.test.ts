import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  reserveManaged: vi.fn(),
  managed: vi.fn(),
  settle: vi.fn(),
  put: vi.fn(),
}));
vi.mock("./provider-budget.server", () => ({
  reserveProviderUsage: mocks.reserve,
  reserveManagedProviderUsage: mocks.reserveManaged,
  hasManagedProviderBudget: mocks.managed,
  settleProviderUsage: mocks.settle,
}));
vi.mock("./r2-storage.server", () => ({ getMediaBucket: () => ({ put: mocks.put }) }));
vi.mock("./studio-reel-host.server", () => ({ hostedStudioReelAttemptCost: () => 50_000 }));
import {
  analyzeReferenceMedia,
  describeReferenceImage,
  downloadInstagramReference,
  referenceVideoFrames,
  transcribeReferenceAudio,
} from "./content-reference-analysis.server";
const actor = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  authUserId: "22222222-2222-4222-8222-222222222222",
};
const sourceUrl = "https://www.instagram.com/p/abc/";
const video = { kind: "video" as const, mime: "video/mp4", bytes: new Uint8Array([1, 2, 3]) };
const grid = {
  mode: "all",
  decodedFrameCount: 2,
  includedFrameCount: 2,
  durationSeconds: 1,
  width: 200,
  height: 120,
  columns: 2,
  rows: 1,
  cellWidth: 100,
  cellHeight: 120,
  frames: [
    { index: 0, timestampSeconds: 0 },
    { index: 1, timestampSeconds: 0.5 },
  ],
  jpegBase64:
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAACAEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAHgAyAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJ/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//9k=",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.reserve.mockResolvedValue(undefined);
  mocks.reserveManaged.mockResolvedValue({ id: actor.workspaceId, units: 50_000, managed: true });
  mocks.managed.mockReturnValue(true);
  vi.stubEnv("COBALT_API_URL", "https://media.test.bento.surf/");
  vi.stubEnv("COBALT_API_KEY", "fixture-key");
  vi.stubEnv("STUDIO_REEL_RENDERER_URL", "https://renderer.test/render");
  vi.stubEnv("STUDIO_REEL_RENDERER_TOKEN", "a".repeat(40));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("reserves scoped resolver usage before network and performs no download when denied", async () => {
  const fetcher = vi.fn();
  mocks.reserve.mockRejectedValueOnce(new Error("Limit reached"));
  await expect(downloadInstagramReference(actor, sourceUrl, fetcher)).rejects.toThrow(
    "Limit reached",
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(mocks.reserve).toHaveBeenCalledWith("mcp_media_resolutions", 1, {
    workspaceId: actor.workspaceId,
    managedCostMicrousd: 500,
  });
});
it("downloads ordered carousel evidence only through the configured signed gateway, without credentials on media reads", async () => {
  const urls = [
    "https://media.test.bento.surf/instagram-media?signature=one",
    "https://media.test.bento.surf/instagram-media?signature=two",
  ];
  const fetcher = vi.fn(async (target, _init?: RequestInit) =>
    String(target).endsWith("/instagram-reference")
      ? Response.json({
          source: { url: sourceUrl, shortcode: "abc", caption: "Reference" },
          items: urls.map((url, index) => ({
            kind: "image",
            url,
            filename: `slide_${index + 1}.jpg`,
          })),
        })
      : new Response(new Uint8Array([urls.indexOf(String(target)) + 1]), {
          headers: { "content-type": "image/jpeg" },
        }),
  );
  const result = await downloadInstagramReference(actor, sourceUrl, fetcher);
  expect(result.assets.map(({ bytes }) => bytes[0])).toEqual([1, 2]);
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    redirect: "manual",
    headers: { authorization: "Api-Key fixture-key" },
  });
  for (const [, init] of fetcher.mock.calls.slice(1)) expect(init?.headers).toBeUndefined();
});
it("rejects a resolver redirect without following it or forwarding credentials", async () => {
  const fetcher = vi.fn(async (_target, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    return Response.redirect("https://untrusted.test/", 302);
  });
  await expect(downloadInstagramReference(actor, sourceUrl, fetcher)).rejects.toThrow(
    "could not be downloaded",
  );
  expect(fetcher).toHaveBeenCalledOnce();
});
it("rejects redirected signed media without fetching the redirect target", async () => {
  const fetcher = vi.fn(async (target, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    return String(target).endsWith("/instagram-reference")
      ? Response.json({
          source: { url: sourceUrl, shortcode: "abc" },
          items: [
            {
              kind: "image",
              url: "https://media.test.bento.surf/instagram-media?signature=x",
              filename: "slide.jpg",
            },
          ],
        })
      : Response.redirect("https://untrusted.test/", 307);
  });
  await expect(downloadInstagramReference(actor, sourceUrl, fetcher)).rejects.toThrow(
    "expected media",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("rejects a renderer redirect without following it or settling an incomplete attempt", async () => {
  const fetcher = vi.fn(async (_target, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    return Response.redirect("https://untrusted.test/", 308);
  });
  await expect(referenceVideoFrames(actor, video, "all", false, fetcher)).rejects.toThrow(
    "could not be decoded",
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(mocks.settle).not.toHaveBeenCalled();
});
it.each([
  "https://evil.test/instagram-media?signature=x",
  "https://media.test.bento.surf/tunnel?signature=x",
])("rejects an unsafe media location %s before fetching it", async (url) => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      source: { url: sourceUrl, shortcode: "abc" },
      items: [{ kind: "video", url, filename: "ref.mp4" }],
    }),
  );
  await expect(downloadInstagramReference(actor, sourceUrl, fetcher)).rejects.toThrow("unsafe");
  expect(fetcher).toHaveBeenCalledOnce();
});
it("never lets a cover-only Reel become successful image analysis", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      source: { url: sourceUrl, shortcode: "abc" },
      items: [
        {
          kind: "image",
          url: "https://media.test.bento.surf/instagram-media?signature=x",
          filename: "cover.jpg",
        },
      ],
    }),
  );
  await expect(
    downloadInstagramReference(actor, "https://www.instagram.com/reel/abc/", fetcher),
  ).rejects.toThrow("only a cover");
  expect(fetcher).toHaveBeenCalledOnce();
});
it.each([
  ["image", "video"],
  ["video", "video"],
])("rejects a %s/%s manifest before any asset download", async (...kinds) => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      source: { url: sourceUrl, shortcode: "abc" },
      items: kinds.map((kind, index) => ({
        kind,
        url: `https://media.test.bento.surf/instagram-media?signature=${index}`,
        filename: `asset_${index}`,
      })),
    }),
  );
  await expect(downloadInstagramReference(actor, sourceUrl, fetcher)).rejects.toThrow(
    "Video carousels are unsupported",
  );
  expect(fetcher).toHaveBeenCalledOnce();
});
it("cancels an in-flight read at the aggregate limit even without content-length headers", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const canceledAfterChunks: number[] = [];
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(async (target, init?: RequestInit) => {
    if (String(target).endsWith("/instagram-reference"))
      return Response.json({
        source: { url: sourceUrl, shortcode: "abc" },
        items: Array.from({ length: 20 }, (_, index) => ({
          kind: "image",
          url: `https://media.test.bento.surf/instagram-media?signature=${index}`,
          filename: `slide_${index}.jpg`,
        })),
      });
    signals.push(init!.signal!);
    let chunks = 0;
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (chunks === 2) controller.close();
            else {
              chunks++;
              controller.enqueue(chunk);
            }
          },
          cancel() {
            canceledAfterChunks.push(chunks);
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "image/jpeg" } },
    );
  });
  await expect(downloadInstagramReference(actor, sourceUrl, fetcher)).rejects.toThrow(
    "must total 24 MiB or less",
  );
  expect(canceledAfterChunks).toContain(1);
  expect(signals.every(({ aborted }) => aborted)).toBe(true);
  expect(fetcher.mock.calls.length).toBeLessThan(21);
});
it("never invokes hosted compute for an ineligible managed reservation", async () => {
  const fetcher = vi.fn();
  mocks.reserveManaged.mockRejectedValueOnce(new Error("Creator has no managed funding"));
  await expect(referenceVideoFrames(actor, video, "all", false, fetcher)).rejects.toThrow(
    "no managed funding",
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(mocks.reserveManaged).toHaveBeenCalledWith(
    expect.objectContaining({ ...actor, units: 50_000, providerUnits: 90_000 }),
  );
});
it("sends actual image bytes to vision after its reservation, and does not invent output when denied", async () => {
  const run = vi
    .fn()
    .mockResolvedValue({ response: '{"description":"A large title above two panels."}' });
  expect(
    await describeReferenceImage(actor, new Uint8Array([255, 216, 255]), "Slide1", { AI: { run } }),
  ).toContain("two panels");
  expect(run.mock.calls[0][1].image).toEqual([255, 216, 255]);
  expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  mocks.reserve.mockRejectedValueOnce(new Error("Budget denied"));
  await expect(
    describeReferenceImage(actor, new Uint8Array([1]), "Slide2", { AI: { run } }),
  ).rejects.toThrow("Budget denied");
  expect(run).toHaveBeenCalledOnce();
});
const visibleText = "[00:02] A blue opening card gives way to two numbered panels.";
it.each([
  ["plain response", { response: `  ${visibleText}  ` }],
  ["message text", { choices: [{ message: { content: visibleText } }] }],
  ["JSON string", { response: JSON.stringify({ description: visibleText }) }],
  ["JSON object", { response: { description: visibleText } }],
  ["result preamble", { response: "Result: " + JSON.stringify({ description: visibleText }) }],
  ["prefixed JSON", { response: "Note:\n" + JSON.stringify({ description: visibleText }) }],
  [
    "prefixed fenced JSON",
    { response: "Note:\n```json\n" + JSON.stringify({ description: visibleText }) + "\n```" },
  ],
  [
    "fenced JSON",
    { response: "```json\n" + JSON.stringify({ description: visibleText }) + "\n```" },
  ],
])("reads the actual %s in a single vision request", async (_label, response) => {
  const run = vi.fn().mockResolvedValue(response);
  await expect(
    describeReferenceImage(actor, new Uint8Array([255, 216, 255]), "Slide", { AI: { run } }),
  ).resolves.toBe(visibleText);
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "@cf/meta/llama-3.2-11b-vision-instruct",
    expect.objectContaining({
      prompt: expect.stringMatching(/plain text.*1,?500/i),
      max_tokens: 500,
      image: [255, 216, 255],
    }),
    expect.anything(),
  );
  expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith("vision_images", 1, {
    workspaceId: actor.workspaceId,
    managedCostMicrousd: 10000,
  });
});
it.each([
  "[0.000000] A title card opens on a blue background.",
  "[00:00–00:04] A presenter holds the card.",
  "[Opening shot] A white headline fills the frame.",
  'The card shows {"description":"Example"} under the title.',
  'Opening card: {"description":"Example"} appears under the title.',
  "The card shows {USD}",
  'The card shows {"description":"Example"}',
])("keeps the full plain-text grid description %s", async (description) => {
  const run = vi.fn().mockResolvedValue({ response: description });
  await expect(
    describeReferenceImage(actor, new Uint8Array([1]), "Grid", { AI: { run } }, "video_grid"),
  ).resolves.toBe(description);
  expect(run).toHaveBeenCalledOnce();
});
it.each([
  ["blank", { response: " \n " }, "text", "empty"],
  ["unknown envelope", { internal: "private diagnostic" }, "object", "invalid_shape"],
  [
    "unknown JSON shape",
    { response: { unknown: "private diagnostic" } },
    "object",
    "invalid_shape",
  ],
  ["blank JSON description", { response: '{"description":" "}' }, "text", "empty"],
  [
    "prefixed truncated JSON",
    { response: 'Note:\n{"description":"private diagnostic' },
    "text",
    "invalid_json",
  ],
  ["malformed JSON", { response: '{"description":}' }, "text", "invalid_json"],
  ["truncated JSON", { response: '{"description":"private diagnostic' }, "text", "invalid_json"],
  [
    "trailing text",
    { response: '{"description":"private diagnostic"} extra' },
    "text",
    "invalid_json",
  ],
  [
    "truncated fence",
    { response: '```json\n{"description":"private diagnostic"}' },
    "text",
    "invalid_json",
  ],
  ["scalar array", { response: "[0.000000]" }, "text", "invalid_shape"],
  ["truncated array", { response: '[{"description":"incomplete"}' }, "text", "invalid_json"],
  [
    "JSON array with trailing words",
    { response: '["something"] and more' },
    "text",
    "invalid_json",
  ],
  ["JSON array", { response: '[{"description":"private diagnostic"}]' }, "text", "invalid_shape"],
  ["oversize plain text", { response: "x".repeat(4001) }, "text", "too_long"],
  [
    "oversize JSON description",
    { response: JSON.stringify({ description: "x".repeat(4001) }) },
    "text",
    "too_long",
  ],
  ["provider array", { response: ["private diagnostic"] }, "array", "invalid_shape"],
  ["missing output", null, "missing", "invalid_shape"],
] as const)(
  "rejects %s without storing or logging the output",
  async (_label, response, outputKind, validationCode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn().mockResolvedValue(response);
    const { evidence } = await analyzeReferenceMedia(
      actor,
      actor.workspaceId,
      [{ kind: "image", mime: "image/jpeg", bytes: new Uint8Array([255, 216, 255]) }],
      "overview",
      { AI: { run } },
    );
    expect(evidence.visuals).toEqual([]);
    expect(evidence.warnings).toEqual(["Visual analysis is unavailable for slide 1."]);
    const text = response && "response" in response ? response.response : undefined;
    expect(warn).toHaveBeenCalledExactlyOnceWith("content_reference_vision_failed", {
      workspaceId: actor.workspaceId,
      kind: "image",
      stage: "output",
      reason: "invalid_output",
      outputKind,
      validationCode,
      ...(typeof text === "string" ? { characterCount: text.length } : {}),
    });
    expect(run).toHaveBeenCalledOnce();
    expect(mocks.reserve).toHaveBeenCalledOnce();
  },
);
it("keeps provider failure details out of video-grid diagnostics", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const run = vi.fn().mockRejectedValue(new Error("fixture private token, URL and prompt"));
  await expect(
    describeReferenceImage(
      actor,
      new Uint8Array([1]),
      "private prompt",
      { AI: { run } },
      "video_grid",
    ),
  ).rejects.toThrow("Visual analysis is unavailable");
  expect(warn).toHaveBeenCalledExactlyOnceWith("content_reference_vision_failed", {
    workspaceId: actor.workspaceId,
    kind: "video_grid",
    stage: "provider",
    reason: "provider",
  });
  expect(run).toHaveBeenCalledOnce();
  expect(mocks.reserve).toHaveBeenCalledOnce();
});
it("allows a slower video-grid assessment without buying a second vision attempt", async () => {
  vi.useFakeTimers();
  const run = vi.fn(
    () =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ response: '{"description":"A presenter followed by labeled scenes."}' }),
          25_000,
        );
      }),
  );
  const result = expect(
    describeReferenceImage(
      actor,
      new Uint8Array([255, 216, 255]),
      "24 video frames",
      { AI: { run } },
      "video_grid",
    ),
  ).resolves.toBe("A presenter followed by labeled scenes.");
  await vi.advanceTimersByTimeAsync(25_000);
  await result;
  expect(run).toHaveBeenCalledOnce();
  expect(mocks.reserve).toHaveBeenCalledOnce();
});
it.each([
  { model: "@cf/meta/llama-3.2-11b-vision-instruct", delay: 20_000, kind: "vision" },
  { model: "@cf/meta/llama-3.2-11b-vision-instruct", delay: 60_000, kind: "video_grid" },
  { model: "@cf/openai/whisper-large-v3-turbo", delay: 45_000, kind: "speech" },
])("aborts the actual $kind provider binding at its deadline", async ({ model, delay, kind }) => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const run = vi.fn(() => new Promise<never>(() => {}));
  const env = { AI: { run }, CLOUDFLARE_AI_GATEWAY_ID: "test-gateway" };
  const work =
    kind === "speech"
      ? transcribeReferenceAudio(actor, new TextEncoder().encode("RIFF0000WAVE"), env)
      : describeReferenceImage(
          actor,
          new Uint8Array([1]),
          "Slide",
          env,
          kind === "video_grid" ? "video_grid" : "image",
        );
  const result = expect(work).rejects.toThrow("Reference analysis took too long");
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledExactlyOnceWith(model, expect.any(Object), {
    signal: expect.any(AbortSignal),
    gateway: { id: "test-gateway", collectLog: false, skipCache: true },
  });
  const [[, , { signal }]] = (run as ReturnType<typeof vi.fn>).mock.calls;
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(delay);
  await result;
  expect(signal.aborted).toBe(true);
  if (kind !== "speech")
    expect(warn).toHaveBeenCalledExactlyOnceWith("content_reference_vision_failed", {
      workspaceId: actor.workspaceId,
      kind: kind === "vision" ? "image" : "video_grid",
      stage: "provider",
      reason: "deadline",
    });
  expect(mocks.reserve).toHaveBeenCalledOnce();
});
it("stores a complete grid privately without voice or vision requests when only a frame grid was requested", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(grid));
  vi.stubGlobal("fetch", fetcher);
  const run = vi.fn();
  const result = await analyzeReferenceMedia(
    actor,
    actor.workspaceId,
    [video],
    "all",
    { AI: { run } },
    {},
    true,
  );
  expect(result.evidence.grid).toMatchObject({
    mode: "all",
    includedFrameCount: 2,
    decodedFrameCount: 2,
  });
  expect(mocks.put.mock.calls.map(([key]) => key)).toEqual([
    `private/users/${actor.workspaceId}/references/${actor.workspaceId}/grid.jpg`,
    `private/users/${actor.workspaceId}/references/${actor.workspaceId}/grid.json`,
  ]);
  expect(run).not.toHaveBeenCalled();
  expect(mocks.reserve).not.toHaveBeenCalled();
  const form = fetcher.mock.calls[0][1].body as FormData;
  expect(JSON.parse(String(form.get("options")))).toEqual({ mode: "all", includeAudio: false });
});
