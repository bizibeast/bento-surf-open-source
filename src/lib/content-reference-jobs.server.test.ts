import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  workspace: vi.fn(),
  plan: "creator",
  catalog: "2026-10",
  analyze: vi.fn(),
  download: vi.fn(),
  send: vi.fn(),
  bucket: { get: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "profiles")
        return query({ plan_id: mocks.plan, billing_catalog: mocks.catalog });
      if (table === "complimentary_plan_grants") return query(null);
      return mocks.from(table);
    },
    rpc: mocks.rpc,
  },
}));
vi.mock("./workspace-session.server", () => ({ resolveWorkspace: mocks.workspace }));
vi.unmock("./provider-budget.server");

vi.mock("./content-reference-analysis.server", () => ({
  analyzeReferenceMedia: mocks.analyze,
  downloadInstagramReference: mocks.download,
}));
vi.mock("./r2-storage.server", () => ({
  getMediaBucket: () => mocks.bucket,
  validateMediaObjectKey: (key: string) => key,
}));
vi.mock("./request-security.server", async (original) => ({
  ...(await original<typeof import("./request-security.server")>()),
  enforceRequestRateLimit: vi.fn(),
}));
import {
  handleContentReferenceAssetRequest,
  isContentReferenceEnabled,
  processContentReferenceMessage,
  queueContentReference,
  readContentReference,
  recoverContentReferences,
} from "./content-reference-jobs.server";
import { registerContentStudioMcpTools } from "./content-studio-mcp.server";
import { encryptServerSecret } from "./secret-crypto.server";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const actor = { workspaceId, authUserId };
const input = {
  workspaceId,
  requestId: jobId,
  sourceUrl: "https://www.instagram.com/p/abc/",
  mode: "overview" as const,
  rightsConfirmed: true as const,
};
const row = {
  id: jobId,
  workspace_id: workspaceId,
  auth_user_id: authUserId,
  input: { request: input, gridOnly: false },
  status: "processing",
  evidence: null,
  has_grid: false,
  error_message: null,
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  attempts: 1,
  lease_id: jobId,
};
function query(data: unknown, error: unknown = null) {
  const response = { data, error };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of [
    "select",
    "eq",
    "gt",
    "lt",
    "order",
    "limit",
    "update",
    "is",
    "not",
    "delete",
  ])
    chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => response);
  chain.then = vi.fn((resolve) => Promise.resolve(response).then(resolve));
  return chain;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BENTO_V2_REFERENCE_ANALYSIS_ENABLED", "true");
  vi.stubEnv("EXTERNAL_TOOL_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("VITE_APP_URL", "https://app.test.bento.surf");
  vi.stubGlobal("__env__", { CONTENT_MEDIA_QUEUE: { send: mocks.send } });
  mocks.workspace.mockResolvedValue({ workspaceId, workspace: { status: "active" } });
  mocks.plan = "creator";
  mocks.catalog = "2026-10";
  vi.stubEnv("BENTO_EDITION", "hosted");
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.send.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("private reference jobs", () => {
  it("rejects a foreign actor or ineligible frame execution before queue/database/provider work", async () => {
    await expect(queueContentReference(actor, { ...input, workspaceId: jobId })).rejects.toThrow(
      "another workspace",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();

    await expect(queueContentReference(actor, input, true)).rejects.toThrow("Creator+");
    await expect(
      queueContentReference(actor, { ...input, sourceUrl: "https://instagram.com/reels/abc123/" }),
    ).rejects.toThrow("Creator+");
    await expect(
      queueContentReference(actor, { ...input, sourceUrl: undefined, mediaId: jobId }),
    ).rejects.toThrow("Creator+");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("never starts media/AI work for an already claimed or duplicate delivery", async () => {
    const claim = query(null);
    mocks.from.mockReturnValue(claim);
    await processContentReferenceMessage({ kind: "content_reference_analysis", jobId });
    expect(claim.eq).toHaveBeenCalledWith("status", "queued");
    expect(claim.eq).toHaveBeenCalledWith("attempts", 0);
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("saves completed evidence only under its owned unexpired lease", async () => {
    const claim = query(row),
      save = query({ id: jobId });
    mocks.from.mockReturnValueOnce(claim).mockReturnValueOnce(save);
    mocks.download.mockResolvedValue({
      source: { caption: "Reference" },
      assets: [{ kind: "image", bytes: new Uint8Array([1]), mime: "image/jpeg" }],
    });
    mocks.analyze.mockResolvedValue({
      evidence: {
        format: "image",
        visuals: [{ index: 0, description: "Two centered lines of text" }],
        warnings: [],
      },
      hasGrid: false,
    });
    await processContentReferenceMessage({ kind: "content_reference_analysis", jobId });
    expect(save.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(save.eq).toHaveBeenCalledWith("lease_id", expect.any(String));
    expect(save.gt).toHaveBeenCalledWith("lease_expires_at", expect.any(String));
    expect(save.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready", has_grid: false }),
    );
    expect(mocks.analyze).toHaveBeenCalledOnce();
  });
  it("lets Creator queue and read owned image research and denies Store", async () => {
    const evidence = {
      format: "image",
      visuals: [{ index: 0, description: "Title" }],
      warnings: [],
    };
    mocks.from.mockReturnValueOnce(query({ ...row, status: "queued" }));
    mocks.rpc.mockResolvedValueOnce({ data: jobId, error: null });
    await expect(queueContentReference(actor, input)).resolves.toMatchObject({
      id: jobId,
      status: "queued",
    });
    mocks.from.mockReturnValueOnce(query({ ...row, evidence, status: "ready" }));
    await expect(readContentReference(actor, jobId)).resolves.toMatchObject({ evidence });
    mocks.plan = "store";
    await expect(readContentReference(actor, jobId)).rejects.toThrow();
    await expect(queueContentReference(actor, input)).rejects.toThrow();
    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("denies video found in a post before decoding on Creator", async () => {
    const failure = query(null);
    mocks.from.mockReturnValueOnce(query(row)).mockReturnValueOnce(failure);
    mocks.download.mockResolvedValue({ source: {}, assets: [{ kind: "video" }] });
    await processContentReferenceMessage({ kind: "content_reference_analysis", jobId });
    expect(failure.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error_message: expect.stringContaining("Creator+"),
      }),
    );
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it.each(["creator", "creator_plus"])(
    "charges the correct resolver and vision meters for %s",
    async (plan) => {
      mocks.plan = plan;
      mocks.catalog = plan === "creator" ? "2026-10" : "2026-11-managed";
      vi.stubEnv("DODO_FULLY_MANAGED_99_MONTHLY_PRODUCT_ID", "fixture");
      vi.stubEnv("COBALT_API_URL", "https://media.test.bento.surf/");
      vi.stubEnv("COBALT_API_KEY", "fixture");
      const real = await vi.importActual<typeof import("./content-reference-analysis.server")>(
        "./content-reference-analysis.server",
      );
      mocks.download.mockImplementationOnce(real.downloadInstagramReference);
      mocks.analyze.mockImplementationOnce(real.analyzeReferenceMedia);
      const run = vi.fn().mockResolvedValue({ response: '{"description":"A large title."}' });
      vi.stubGlobal("__env__", { CONTENT_MEDIA_QUEUE: {}, AI: { run } });
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            source: { url: input.sourceUrl, shortcode: "abc" },
            items: [
              {
                kind: "image",
                url: "https://media.test.bento.surf/instagram-media?signature=abc",
                filename: "photo.jpg",
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          new Response("image", { headers: { "content-type": "image/jpeg" } }),
        );
      vi.stubGlobal("fetch", fetcher);
      const save = query({ id: jobId });
      mocks.from.mockReturnValueOnce(query(row)).mockReturnValueOnce(save);
      mocks.rpc.mockImplementation(async (name) => ({
        data: name === "reserve_provider_usage" ? true : { allowed: true, reservation_id: jobId },
        error: null,
      }));
      await processContentReferenceMessage({ kind: "content_reference_analysis", jobId });
      const held = mocks.rpc.mock.calls;
      expect(held.map(([, args]) => args.p_resource)).toEqual([
        "mcp_media_resolutions",
        "vision_images",
      ]);
      expect(held.map(([rpc]) => rpc)).toEqual(
        Array(2).fill(
          plan === "creator" ? "reserve_provider_usage" : "reserve_managed_provider_usage",
        ),
      );
      expect(held.map(([, args]) => args.p_workspace_id)).toEqual([workspaceId, workspaceId]);
      expect(held.map(([, args]) => args.p_provider_units ?? args.p_units)).toEqual([1, 1]);
      if (plan === "creator_plus")
        expect(held.map(([, args]) => args.p_microusd)).toEqual([500, 10000]);
      expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
        fetcher.mock.invocationCallOrder[0],
      );
      expect(mocks.rpc.mock.invocationCallOrder[1]).toBeLessThan(run.mock.invocationCallOrder[0]);
      expect(save.update).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
    },
  );
  it.each(["exhausted", "unavailable"])(
    "fails closed before the resolver for %s Creator+ credit",
    async (reason) => {
      mocks.plan = "creator_plus";
      mocks.catalog = "2026-11-managed";
      vi.stubEnv("DODO_FULLY_MANAGED_99_MONTHLY_PRODUCT_ID", "fixture");
      vi.stubEnv("COBALT_API_URL", "https://media.test.bento.surf/");
      vi.stubEnv("COBALT_API_KEY", "fixture");
      const real = await vi.importActual<typeof import("./content-reference-analysis.server")>(
        "./content-reference-analysis.server",
      );
      mocks.download.mockImplementationOnce(real.downloadInstagramReference);
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const failure = query(null);
      mocks.from.mockReturnValueOnce(query(row)).mockReturnValueOnce(failure);
      mocks.rpc.mockResolvedValue({
        data: reason === "exhausted" ? { allowed: false, reason: "managed_week" } : null,
        error: reason === "unavailable" ? {} : null,
      });
      await processContentReferenceMessage({ kind: "content_reference_analysis", jobId });
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
        "reserve_managed_provider_usage",
        expect.objectContaining({ p_resource: "mcp_media_resolutions", p_microusd: 500 }),
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(mocks.analyze).not.toHaveBeenCalled();
      expect(failure.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    },
  );
  it.each([true, false])(
    "requires positive verified allowance to queue a frame grid (credit available: %s)",
    async (available) => {
      mocks.plan = "creator_plus";
      mocks.catalog = "2026-11-managed";
      vi.stubEnv("DODO_FULLY_MANAGED_99_MONTHLY_PRODUCT_ID", "fixture");
      const allowance = {
        limitMicrousd: 100000,
        remainingMicrousd: available ? 100000 : 0,
        resetsAt: new Date().toISOString(),
      };
      mocks.rpc.mockResolvedValueOnce({
        data: { eligible: true, weekly: allowance, monthly: allowance },
        error: null,
      });
      const queued = queueContentReference(actor, input, true);
      if (available) {
        mocks.rpc.mockResolvedValueOnce({ data: jobId, error: null });
        mocks.from.mockReturnValueOnce(query({ ...row, status: "queued" }));
        await expect(queued).resolves.toMatchObject({ id: jobId });
        expect(mocks.send).toHaveBeenCalledOnce();
      } else {
        await expect(queued).rejects.toThrow("Creator+");
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
        expect(mocks.send).not.toHaveBeenCalled();
      }
    },
  );
  it("records a failed attempt and never automatically retries the provider", async () => {
    const claim = query(row),
      failure = query(null);
    mocks.from.mockReturnValueOnce(claim).mockReturnValueOnce(failure);
    mocks.download.mockRejectedValue(new Error("No public video is available."));
    await processContentReferenceMessage({ kind: "content_reference_analysis", jobId });
    expect(failure.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error_message: "No public video is available." }),
    );
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it("checks workspace, requester and retention on every status read", async () => {
    const read = query(null);
    mocks.from.mockReturnValue(read);
    await expect(readContentReference(actor, jobId)).rejects.toThrow("unavailable");
    expect(read.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(read.eq).toHaveBeenCalledWith("auth_user_id", authUserId);
    expect(read.gt).toHaveBeenCalledWith("expires_at", expect.any(String));
  });
  it("returns absolute redeemable JPEG and metadata grants for the real Studio MCP actor", async () => {
    vi.stubEnv("BENTO_V2_STUDIO_ENABLED", "true");
    const registerTool = vi.fn();
    const resolveWorkspace = vi.fn().mockResolvedValue(workspaceId);
    registerContentStudioMcpTools(
      { registerTool },
      {
        clientId: "external-fixture",
        token: "fixture",
        scopes: ["openid"],
        extra: { userId: authUserId },
      },
      resolveWorkspace,
    );
    const ready = { ...row, status: "ready", has_grid: true };
    mocks.from.mockReturnValue(query(ready));
    const get = registerTool.mock.calls.find(([name]) => name === "get_content_reference");
    if (!get) throw new Error("Reference status tool is missing.");
    const { gridUrl, frameMetadataUrl } = (await get[2]({ workspaceId, jobId })).structuredContent
      .result;
    expect(resolveWorkspace).toHaveBeenCalledExactlyOnceWith(authUserId, workspaceId);
    for (const [url, asset, mime, body] of [
      [gridUrl, "grid.jpg", "image/jpeg", "fake jpeg"],
      [frameMetadataUrl, "grid.json", "application/json", "{}"],
    ]) {
      expect(new URL(url).origin).toBe("https://app.test.bento.surf");
      mocks.bucket.get.mockResolvedValueOnce({ size: body.length, body: new Response(body).body });
      const preview = await handleContentReferenceAssetRequest(new Request(url));
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe(mime);
      expect(preview.headers.get("cache-control")).toBe("private, no-store");
      expect(await preview.text()).toBe(body);
      expect(mocks.bucket.get).toHaveBeenLastCalledWith(
        `private/users/${workspaceId}/references/${jobId}/${asset}`,
      );
    }
  });
  it.each(["disabled", "no queue", "send fails"])(
    "expires existing reference evidence when analysis is %s",
    async (condition) => {
      if (condition === "disabled") vi.stubEnv("BENTO_V2_REFERENCE_ANALYSIS_ENABLED", "false");
      if (condition === "no queue") vi.stubGlobal("__env__", {});
      const expired = query([{ id: jobId, workspace_id: workspaceId }]);
      const cleaned = query(null);
      const clean = vi.fn((_values: unknown) => cleaned);
      const stale = query(null);
      const pending = query([{ id: jobId }]);
      mocks.from.mockReturnValue({
        select: (columns: string) => (columns === "id,workspace_id" ? expired : pending),
        update: (values: { evidence?: unknown }) =>
          values.evidence === null ? clean(values) : stale,
      });
      if (condition === "send fails") {
        mocks.send.mockRejectedValueOnce(new Error("Queue unavailable"));
        await expect(recoverContentReferences()).rejects.toThrow("maintenance was incomplete");
      } else {
        expect(isContentReferenceEnabled()).toBe(false);
        await recoverContentReferences();
        expect(mocks.send).not.toHaveBeenCalled();
      }
      expect(expired.lt).toHaveBeenCalledWith("expires_at", expect.any(String));
      expect(expired.is).toHaveBeenCalledWith("cleaned_at", null);
      expect(mocks.bucket.delete).toHaveBeenCalledExactlyOnceWith([
        `private/users/${workspaceId}/references/${jobId}/grid.jpg`,
        `private/users/${workspaceId}/references/${jobId}/grid.json`,
      ]);
      expect(clean).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: null,
          has_grid: false,
          cleaned_at: expect.any(String),
        }),
      );
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("purge_content_reference_receipts");
    },
  );
  it("allows maintenance before the feature migration on a disabled deployment", async () => {
    vi.stubEnv("BENTO_V2_REFERENCE_ANALYSIS_ENABLED", "false");
    mocks.from.mockReturnValue(query(null, { code: "PGRST205" }));
    await expect(recoverContentReferences()).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("denies expired or wrong-purpose preview grants and rechecks current ownership", async () => {
    const base = {
      purpose: "reference_preview",
      ...actor,
      jobId,
      asset: "grid.jpg",
      expiresAt: Date.now() + 60_000,
    };
    const request = async (grant: typeof base) => {
      const token = await encryptServerSecret(JSON.stringify(grant), "external-tool");
      return new Request(`https://app.test.bento.surf/api/content-reference/asset?grant=${token}`);
    };
    for (const grant of [
      { ...base, expiresAt: Date.now() - 1 },
      { ...base, purpose: "provider_input" },
    ]) {
      expect((await handleContentReferenceAssetRequest(await request(grant))).status).toBe(404);
    }
    mocks.workspace.mockRejectedValueOnce(new Error("Ownership revoked"));
    expect((await handleContentReferenceAssetRequest(await request(base))).status).toBe(404);
    expect(mocks.bucket.get).not.toHaveBeenCalled();
  });
});
