/* eslint-disable @typescript-eslint/no-explicit-any -- Explicit fake storage/database boundaries. */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  row: {} as any,
  put: vi.fn(),
  register: vi.fn(),
  draft: vi.fn(),
  usage: vi.fn(),
  rate: vi.fn(),
  connected: true,
  public: false,
}));
const workspace = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const renderId = "44444444-4444-4444-8444-444444444444";
const media = "55555555-5555-4555-8555-555555555555";
const actor = { workspaceId: workspace, authUserId: user, clientId: "bento-browser" };
vi.mock("./content-reel-production.server", () => ({
  loadReelProductionForActor: async (actor: any, requested: string) => {
    if (
      actor.workspaceId !== f.row.workspace_id ||
      actor.authUserId !== f.row.auth_user_id ||
      requested !== f.row.id
    )
      throw Error("scope");
    return structuredClone(f.row);
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Array<[string, any]> = [];
      let values: any;
      const q: any = {
        select: () => q,
        eq: (k: string, v: any) => {
          filters.push([k, v]);
          return q;
        },
        is: (k: string, v: any) => {
          filters.push([k, v]);
          return q;
        },
        in: () => q,
        limit: () => q,
        update: (v: any) => {
          values = v;
          return q;
        },
      };
      const run = () => {
        if (table === "social_connections")
          return { data: f.connected ? [{ id: media }] : [], error: null };
        if (!filters.every(([k, v]) => f.row[k] === v)) return { data: null, error: null };
        if (values) Object.assign(f.row, values);
        return { data: { id: f.row.id }, error: null };
      };
      q.maybeSingle = async () => run();
      q.then = (resolve: any) => Promise.resolve(run()).then(resolve);
      return q;
    },
    rpc: (...args: any[]) => f.register(...args),
  },
}));
vi.mock("./secret-crypto.server", () => ({
  encryptServerSecret: async (text: string) => text,
  decryptServerSecret: async (text: string) => text,
}));
vi.mock("./request-security.server", () => ({
  enforceRequestRateLimit: (...args: any[]) => f.rate(...args),
}));
vi.mock("./plan.server", () => ({ getStorageAllowanceMb: async () => 100 }));
vi.mock("./r2-usage-cache.server", () => ({
  adjustCachedR2UserStorageBytes: (...args: any[]) => f.usage(...args),
}));
vi.mock("./content-studio-scheduler.server", () => ({
  saveStudioSchedulerDraft: (...args: any[]) => f.draft(...args),
}));
vi.mock("./r2-storage.server", () => ({
  mediaObjectUrl: (key: string) => `https://media.example/${key}`,
  sumR2UserStorageBytes: async () => 0,
  getMediaBucket: () => ({
    head: async (key: string) => (key.startsWith("private/") || f.public ? { size: 10 } : null),
    get: async (_key: string, options: any) => ({
      size: 10,
      body: new Blob([
        "0123456789".slice(
          options?.range?.offset || 0,
          options?.range ? options.range.offset + options.range.length : 10,
        ),
      ]).stream(),
    }),
    put: (...args: any[]) => f.put(...args),
  }),
}));
import {
  getReelProductionPreview,
  handleReelProductionPreview,
  approveReelForScheduler,
} from "./content-reel-preview.server";
function request(grant: any, headers?: HeadersInit) {
  return new Request(
    `https://bento.example/api/studio/reel-preview?grant=${encodeURIComponent(JSON.stringify(grant))}`,
    { headers },
  );
}
function grant() {
  return {
    workspaceId: workspace,
    authUserId: user,
    productionId: id,
    expiresAt: Date.now() + 10000,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.connected = true;
  f.public = false;
  f.row = {
    id,
    workspace_id: workspace,
    auth_user_id: user,
    status: "ready",
    state: { renderJobId: renderId },
    title: "My Reel",
    media_ids: [],
    lease_id: null,
    lease_expires_at: null,
    publication: null,
  };
  f.put.mockImplementation(async () => {
    f.public = true;
  });
  f.register.mockResolvedValue({ data: media, error: null });
  f.draft.mockResolvedValue({ postId: id });
  f.usage.mockResolvedValue(undefined);
});
describe("private Reel preview and explicit Scheduler handoff", () => {
  it("issues short-lived grants without making publishing copies", async () => {
    const result = await getReelProductionPreview(actor, id);
    const issued = JSON.parse(
      new URL(result.previewUrl, "https://bento.example").searchParams.get("grant")!,
    );
    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(900000);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.draft).not.toHaveBeenCalled();
  });
  it("denies expired and cross-tenant grants; supports private range requests", async () => {
    expect((await handleReelProductionPreview(request({ ...grant(), expiresAt: 0 }))).status).toBe(
      404,
    );
    expect(
      (await handleReelProductionPreview(request({ ...grant(), workspaceId: media }))).status,
    ).toBe(404);
    const response = await handleReelProductionPreview(request(grant(), { range: "bytes=2-5" }));
    expect(response.status).toBe(206);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await response.text()).toBe("2345");
    expect(
      (await handleReelProductionPreview(request(grant(), { range: "bytes=30-40" }))).status,
    ).toBe(416);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.rate).toHaveBeenCalled();
  });
  it("requires a ready video and browser approval before exposing media", async () => {
    await expect(
      approveReelForScheduler({ ...actor, clientId: "external-claude" }, id),
    ).rejects.toThrow(/Bento/);
    f.row.status = "rendering";
    await expect(approveReelForScheduler(actor, id)).rejects.toThrow(/finished/);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.draft).not.toHaveBeenCalled();
  });
  it("creates one publishing copy and preserves publication intent in a draft", async () => {
    f.row.publication = {
      body: "Caption",
      connectionIds: [media],
      scheduledAt: "2026-11-20T10:00:00+05:30",
      timezone: "Asia/Kolkata",
    };
    await approveReelForScheduler(actor, id);
    await approveReelForScheduler(actor, id);
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledTimes(1);
    expect(f.usage).toHaveBeenCalledTimes(1);
    expect(f.draft).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: id, mediaIds: [media], proposal: f.row.publication }),
    );
    expect(f.row.lease_id).toBeNull();
  });
  it("fences concurrent approvals and releases failed copy leases", async () => {
    let release!: () => void;
    f.put.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = approveReelForScheduler(actor, id);
    await vi.waitFor(() => expect(f.put).toHaveBeenCalledTimes(1));
    await expect(approveReelForScheduler(actor, id)).rejects.toThrow(/prepared/);
    release();
    await first;
    expect(f.register).toHaveBeenCalledTimes(1);
    f.row.media_ids = [];
    f.public = false;
    f.put.mockRejectedValueOnce(Error("storage unavailable"));
    await expect(approveReelForScheduler(actor, id)).rejects.toThrow(/storage/);
    expect(f.row.lease_id).toBeNull();
  });
  it("does not expose a video for disconnected publishing destinations", async () => {
    f.row.publication = { connectionIds: [media] };
    f.connected = false;
    await expect(approveReelForScheduler(actor, id)).rejects.toThrow(/Reconnect/);
    expect(f.put).not.toHaveBeenCalled();
  });
});
