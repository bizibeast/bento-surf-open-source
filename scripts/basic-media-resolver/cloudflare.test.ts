import { describe, it, expect, vi } from "vitest";

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
