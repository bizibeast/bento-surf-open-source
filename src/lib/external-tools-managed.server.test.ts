/* eslint-disable @typescript-eslint/no-explicit-any -- Stateful fixtures check the real managed provider boundary. */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  job: {} as any,
  grants: [] as any[],
  eligible: true,
  events: [] as string[],
  reserve: vi.fn(),
  settle: vi.fn(),
  speech: vi.fn(),
  put: vi.fn(),
  voices: vi.fn(),
}));
function from(table: string) {
  const filters: Array<(row: any) => boolean> = [];
  let patch: any;
  const query: any = {
    select: () => query,
    eq: (field: string, value: any) => {
      filters.push((row) => row[field] === value);
      return query;
    },
    is: (field: string, value: any) => {
      filters.push((row) => row[field] === value);
      return query;
    },
    update: (value: any) => {
      patch = value;
      return query;
    },
  };
  const run = () => {
    if (table === "managed_heygen_assets")
      return {
        data: fixture.grants.filter((row) => filters.every((match) => match(row))),
        error: null,
      };
    if (table === "external_tool_audit") return { data: {}, error: null };
    if (!filters.every((match) => match(fixture.job))) return { data: null, error: null };
    if (patch) {
      if (patch.usage_reservation_id) fixture.events.push("receipt");
      Object.assign(fixture.job, structuredClone(patch));
    }
    return { data: structuredClone(fixture.job), error: null };
  };
  query.maybeSingle = query.single = async () => run();
  query.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
  return query;
}
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from, rpc: async () => ({ data: crypto.randomUUID(), error: null }) },
}));
vi.mock("./secret-crypto.server", () => ({
  isServerSecretEncryptionKeyValid: () => true,
  encryptServerSecret: async () => "test-asset-grant",
  decryptServerSecret: async () => "never-used",
}));
vi.mock("./provider-budget.server", () => ({
  getManagedSpendStatus: async () => ({ eligible: fixture.eligible }),
  reserveHeyGenByokAttempt: async () => ({ data: crypto.randomUUID(), error: null }),
  reserveManagedProviderUsage: (...args: any[]) => fixture.reserve(...args),
  settleProviderUsage: (...args: any[]) => fixture.settle(...args),
}));
vi.mock("./heygen.server", async (original) => ({
  ...(await original<typeof import("./heygen.server")>()),
  createHeyGenClient: () => ({
    speech: (...args: any[]) => fixture.speech(...args),
    voices: (...args: any[]) => fixture.voices(...args),
  }),
}));
vi.mock("./plan.server", () => ({ getStorageAllowanceMb: async () => 100 }));
vi.mock("./r2-storage.server", () => ({
  getMediaBucket: () => ({ head: async () => null, put: fixture.put }),
  sumR2UserStorageBytes: async () => 0,
}));
vi.mock("./r2-usage-cache.server", () => ({ adjustCachedR2UserStorageBytes: async () => {} }));
vi.mock("./request-security.server", async (original) => ({
  ...(await original<typeof import("./request-security.server")>()),
  enforceRequestRateLimit: async () => {},
}));
import {
  startHeyGenJob,
  listHeyGenVoicesFor,
  requireManagedHeyGenAssets,
  managedHeyGenAvatarCost,
  heyGenSpeechCost,
} from "./external-tools.server";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const revision = "44444444-4444-4444-8444-444444444444";
const actor = { workspaceId, authUserId, clientId: "bento-browser" };
beforeEach(() => {
  fixture.reserve.mockReset();
  fixture.settle.mockReset();
  fixture.speech.mockReset();
  fixture.put.mockReset();
  fixture.voices.mockReset();
  fixture.eligible = true;
  fixture.events = [];
  fixture.grants = [
    {
      workspace_id: workspaceId,
      active: true,
      asset_type: "voice",
      provider_asset_id: "own_voice",
    },
  ];
  fixture.job = {
    id: jobId,
    workspace_id: workspaceId,
    auth_user_id: authUserId,
    client_id: "bento-browser",
    connection_id: null,
    connection_revision: revision,
    billing_mode: "managed",
    output_kind: "audio",
    voice_id: "own_voice",
    voice_name: "Own voice",
    avatar_id: "voiceover",
    avatar_name: "Narration",
    script: "Hello",
    requested_seconds: 8,
    estimated_usd_per_minute: 0.01,
    status: "approved",
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    asset_key: null,
    asset_attempts: 0,
    refresh_after: null,
    provider_video_id: null,
    duration_seconds: null,
  };
  fixture.reserve.mockImplementation(async ({ units }: any) => {
    fixture.events.push("reserve");
    return { id: "55555555-5555-4555-8555-555555555555", units, managed: true };
  });
  fixture.speech.mockImplementation(async () => {
    fixture.events.push("speech");
    return { audio_url: "https://files.heygen.ai/speech.wav", duration: 8, original_words: [] };
  });
  fixture.voices.mockResolvedValue({
    voices: [
      { id: "own_voice", name: "Own voice" },
      { id: "another_creators_voice", name: "Private clone" },
    ],
    nextToken: null,
  });
  vi.stubEnv("BENTO_EXTERNAL_TOOLS_ENABLED", "true");
  vi.stubEnv("BENTO_MANAGED_HEYGEN_ENABLED", "true");
  vi.stubEnv("BENTO_MANAGED_HEYGEN_API_KEY", "synthetic-managed-key-not-a-secret");
  vi.stubEnv("BENTO_MANAGED_HEYGEN_REVISION", revision);
  vi.stubEnv("BENTO_HEYGEN_TTS_MICROUSD_PER_1000_CHARS", "10000");
  vi.stubEnv("BENTO_MANAGED_HEYGEN_STOCK_VOICES", "");
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode("RIFF"));
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.redirect === "error") throw new TypeError("Unsupported redirect mode: error");
      return new Response(bytes);
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("managed HeyGen funding and isolation", () => {
  it("requires explicit pricing and includes contract minimums and billing increments", () => {
    vi.stubEnv("BENTO_HEYGEN_AVATAR_MICROUSD_PER_MINUTE", "2000000");
    vi.stubEnv("BENTO_HEYGEN_AVATAR_BILLING_INCREMENT_SECONDS", "1");
    vi.stubEnv("BENTO_HEYGEN_AVATAR_MINIMUM_SECONDS", "0");
    expect(managedHeyGenAvatarCost(8)).toBe(270000);
    vi.stubEnv("BENTO_HEYGEN_AVATAR_BILLING_INCREMENT_SECONDS", "15");
    expect(managedHeyGenAvatarCost(8)).toBe(500000);
    vi.stubEnv("BENTO_HEYGEN_AVATAR_MINIMUM_SECONDS", "30");
    expect(managedHeyGenAvatarCost(8)).toBe(1000000);
    vi.stubEnv("BENTO_HEYGEN_AVATAR_MINIMUM_SECONDS", "");
    expect(() => managedHeyGenAvatarCost(8)).toThrow(/not configured/);
    expect(heyGenSpeechCost("Hello")).toBe(50);
    vi.stubEnv("BENTO_HEYGEN_TTS_MICROUSD_PER_1000_CHARS", "");
    expect(() => heyGenSpeechCost("Hello")).toThrow(/not configured/);
  });
  it("records an atomic reservation before provider execution and stores narration privately", async () => {
    const result = await startHeyGenJob(actor, jobId);
    expect(fixture.events.slice(0, 3)).toEqual(["reserve", "receipt", "speech"]);
    expect(fixture.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        authUserId,
        attemptId: jobId,
        units: 50,
        provider: "heygen",
        model: "heygen-voice-1",
      }),
    );
    expect(result).toMatchObject({
      billing: "bento_managed",
      outputKind: "audio",
      status: "ready",
    });
    expect(fixture.put).toHaveBeenCalledWith(
      `private/users/${workspaceId}/heygen/${jobId}.wav`,
      expect.anything(),
      expect.objectContaining({
        httpMetadata: { contentType: "audio/wav", cacheControl: "private, no-store" },
      }),
    );
  });
  it("does not call a paid provider when a reservation is denied", async () => {
    fixture.reserve.mockRejectedValue(new Error("Allowance exhausted"));
    await expect(startHeyGenJob(actor, jobId)).rejects.toThrow("Allowance exhausted");
    expect(fixture.speech).not.toHaveBeenCalled();
    expect(fixture.job.status).toBe("approved");
  });
  it("requires Creator+ funding and never falls back to a managed key for an unpaid workspace", async () => {
    fixture.eligible = false;
    await expect(startHeyGenJob(actor, jobId)).rejects.toThrow(
      /Managed avatar generation is unavailable/,
    );
    expect(fixture.reserve).not.toHaveBeenCalled();
    expect(fixture.speech).not.toHaveBeenCalled();
  });
  it("filters shared account catalogs and denies another creator's voice", async () => {
    expect(
      (await listHeyGenVoicesFor(actor, { scope: "private", billing: "managed" })).voices.map(
        (voice) => voice.id,
      ),
    ).toEqual(["own_voice"]);
    await expect(
      requireManagedHeyGenAssets(actor, undefined, "another_creators_voice"),
    ).rejects.toThrow(/authorized/);
    expect(fixture.speech).not.toHaveBeenCalled();
  });
  it("fences duplicate submissions and keeps ambiguous charges reserved without retrying", async () => {
    fixture.speech.mockRejectedValue(new Error("Network response lost"));
    await expect(startHeyGenJob(actor, jobId)).rejects.toThrow("Network response lost");
    expect(fixture.job.status).toBe("submission_unknown");
    expect((await startHeyGenJob(actor, jobId)).status).toBe("submission_unknown");
    expect(fixture.speech).toHaveBeenCalledOnce();
    expect(fixture.reserve).toHaveBeenCalledOnce();
    expect(fixture.settle).not.toHaveBeenCalled();
  });
});
