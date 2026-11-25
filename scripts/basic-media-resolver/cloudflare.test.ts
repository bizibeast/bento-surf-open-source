import { describe, it, expect, vi } from "vitest";
vi.mock("./service.py", () => ({ default: "# reviewed test service\n" }));

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    envVars: Record<string, string> = {};
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async onStop() {}
    async destroy() {
      await this.onStop();
    }
    async getState() {
      return { status: "healthy" };
    }
    renewActivityTimeout() {}
    async containerFetch(request: Request) {
      if (new URL(request.url).pathname === "/stats")
        return Response.json({
          platform: "youtube",
          id: "dQw4w9WgXcQ",
          counts: { views: 10, likes: 2, comments: 0 },
        });
      if (new URL(request.url).pathname === "/resolve")
        return Response.json({
          id: "a".repeat(32),
          filename: "tiktok-7039716639834656002.mp4",
          contentType: "video/mp4",
        });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    }
  },
}));
import { BasicMedia } from "./cloudflare";
const token = "private-only-test-bridge-authentication";
function setup() {
  const values = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(storage),
  };
  const ctx = {
    container: { running: true },
    storage,
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
  };
  const env = { BASIC_MEDIA_TOKEN: token };
  return { create: () => new BasicMedia(ctx as never, env as never), values, pending };
}
function request(path: string) {
  return new Request("https://private-media" + path, {
    method: path === "/resolve" ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(path === "/resolve"
      ? { body: JSON.stringify({ url: "https://www.tiktok.com/@a/video/7039716639834656002" }) }
      : {}),
  });
}
describe("container job handoff", () => {
  it("reserves a bounded metadata attempt and never consumes media-transfer bytes", async () => {
    const { create, values } = setup();
    const response = await create().fetch(
      new Request("https://private-media/stats", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ counts: { views: 10, likes: 2, comments: 0 } });
    expect(values.has("attempts")).toBe(true);
    expect(values.has("transfer")).toBe(false);
    expect(values.get("serviceRevision")).toMatch(/^[a-f0-9]{64}$/);
    expect(create().entrypoint?.[2]).toContain("runpy.run_path");
    const warm = create();
    const destroy = vi.spyOn(warm, "destroy");
    await warm.fetch(
      new Request("https://private-media/stats", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ" }),
      }),
    );
    expect(destroy).not.toHaveBeenCalled();
  });
  it("reports private usage without consuming attempts or exposing credentials", async () => {
    const { create, values } = setup();
    const attempts = { day: "2026-11-21", month: "2026-11", daily: 50, monthly: 50 };
    values.set("attempts", attempts);
    const response = await create().fetch(request("/health"));
    expect(await response.json()).toEqual({ ok: true, attempts, transfer: null });
    expect(values.get("attempts")).toEqual(attempts);
    const rejected = await create().fetch(new Request("https://private-media/health"));
    expect(rejected.status).toBe(401);
  });
  it("preserves a resolved job when a delayed stop callback arrives", async () => {
    const { create, pending } = setup();
    const instance = create();
    expect((await instance.fetch(request("/resolve"))).status).toBe(200);
    await instance.onStop();
    const stream = await instance.fetch(request("/stream/" + "a".repeat(32)));
    expect(stream.status).toBe(200);
    expect((await stream.arrayBuffer()).byteLength).toBe(3);
    await Promise.all(pending);
  });
  it("recovers the private token after the Durable Object isolate is recreated", async () => {
    const { create, pending } = setup();
    expect((await create().fetch(request("/resolve"))).status).toBe(200);
    const stream = await create().fetch(request("/stream/" + "a".repeat(32)));
    expect(stream.status).toBe(200);
    expect((await stream.arrayBuffer()).byteLength).toBe(3);
    await Promise.all(pending);
  });
});
it("credential restart cannot reset or bypass the persisted attempt budget", async () => {
  const { create, values } = setup();
  const now = new Date().toISOString();
  values.set("attempts", {
    day: now.slice(0, 10),
    month: now.slice(0, 7),
    daily: 49,
    monthly: 249,
  });
  const instance = create();
  expect((await instance.fetch(request("/resolve"))).status).toBe(200);
  const charged = values.get("attempts");
  expect(values.has("containerToken")).toBe(true);
  const restarted = await instance.fetch(
    new Request("https://private-media/restart", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(restarted.status).toBe(200);
  expect(values.has("containerToken")).toBe(false);
  expect(values.get("attempts")).toEqual(charged);
  expect((await instance.fetch(request("/resolve"))).status).toBe(429);
});
