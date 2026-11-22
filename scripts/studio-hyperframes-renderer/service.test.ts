// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hyperframesService } from "./service";
import { studioStarter } from "../../src/lib/content-studio";
import { DEFAULT_AGENT_BRANDING } from "../../src/lib/content-agent-branding";
import { STUDIO_REEL_INPUT_LIMIT } from "../../src/lib/studio-reel-host";

const token = "test_renderer_token_12345678901234567890";
const document = () => studioStarter("reel", "captions", DEFAULT_AGENT_BRANDING).document;
let directory: string;
let handler: ReturnType<typeof hyperframesService>;

function request(input: unknown = { document: document(), assets: [] }, signal?: AbortSignal) {
  const form = new FormData();
  form.set("document", JSON.stringify(input));
  return new Request("https://renderer.invalid/render", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
    signal,
  });
}

describe("private HyperFrames service contract (fake executable, no media provider)", () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "benny-render-test-"));
    const binary = join(directory, "renderer");
    // Exercise the real subprocess boundary; this fake is deliberately not an MP4 renderer.
    await writeFile(
      binary,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(directory, "observed.json"))}, JSON.stringify({
  cwd: process.cwd(), env: process.env, args: process.argv.slice(2),
  html: fs.readFileSync('index.html', 'utf8')
}));
setTimeout(() => fs.writeFileSync('output.mp4', Buffer.from('0000ftypfake')), 100);
`,
      { mode: 0o700 },
    );
    const gsap = join(directory, "gsap.js");
    const font = join(directory, "font.ttf");
    await writeFile(gsap, "/* fake dependency */");
    await writeFile(font, "fake font");
    handler = hyperframesService({ token, binary, gsap, font });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("requires a strong private token and rejects oversized or malformed input", async () => {
    expect(() => hyperframesService({ token: "weak", binary: "", gsap: "", font: "" })).toThrow();
    const unauthorized = request();
    unauthorized.headers.delete("authorization");
    expect((await handler(unauthorized)).status).toBe(401);
    const oversized = request();
    oversized.headers.set("content-length", String(STUDIO_REEL_INPUT_LIMIT + 262_145));
    expect((await handler(oversized)).status).toBe(413);
    expect((await handler(request({ document: { shell: "bad" }, assets: [] }))).status).toBe(422);
  });

  it("passes only fixed arguments and safe environment values, then removes temporary media", async () => {
    process.env.BENNY_RENDER_TEST_SECRET = "never-send-to-child";
    try {
      const response = await handler(request());
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      const observed = JSON.parse(await readFile(join(directory, "observed.json"), "utf8"));
      expect(observed.env.BENNY_RENDER_TEST_SECRET).toBeUndefined();
      expect(observed.env.STUDIO_REEL_RENDERER_TOKEN).toBeUndefined();
      expect(observed.env.HYPERFRAMES_CHROME_SANDBOX).toBe("1");
      expect(observed.env.DO_NOT_TRACK).toBe("1");
      expect(observed.args).toEqual([
        "render",
        "--output",
        "output.mp4",
        "--workers",
        "1",
        "--quality",
        "standard",
      ]);
      expect(observed.html).toContain('data-width="1080"');
      await expect(readFile(join(observed.cwd, "index.html"))).rejects.toThrow();
    } finally {
      delete process.env.BENNY_RENDER_TEST_SECRET;
    }
  });

  it("limits concurrency and recovers after cancellation", async () => {
    const controller = new AbortController();
    const active = handler(request(undefined, controller.signal));
    expect((await handler(request())).status).toBe(503);
    await expect
      .poll(
        async () =>
          readFile(join(directory, "observed.json"), "utf8")
            .then(() => true)
            .catch(() => false),
        { timeout: 5000, interval: 20 },
      )
      .toBe(true);
    controller.abort();
    expect((await active).status).toBe(422);
    expect((await handler(request())).status).toBe(200);
  });

  it("rejects missing scene assets before invoking the executable", async () => {
    const reel = document();
    const id = "77777777-7777-4777-8777-777777777777";
    expect(
      (await handler(request({ document: reel, assets: [{ id, kind: "video" }] }))).status,
    ).toBe(422);
    await expect(readFile(join(directory, "observed.json"))).rejects.toThrow();
  });
  it("rejects oversized chunked uploads and releases a cancelled upload slot", async () => {
    const chunked = new Request("https://renderer.invalid/render", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(STUDIO_REEL_INPUT_LIMIT + 262145));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await handler(chunked)).status).toBe(413);
    const controller = new AbortController();
    const slow = new Request("https://renderer.invalid/render", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new ReadableStream({
        pull() {
          /* deliberately waits for cancellation */
        },
      }),
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    const running = handler(slow);
    controller.abort();
    expect((await running).status).toBe(422);
    expect((await handler(request())).status).toBe(200);
  });
});
