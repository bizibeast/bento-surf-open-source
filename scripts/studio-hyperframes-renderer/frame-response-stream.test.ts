// @vitest-environment node
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let miniflare: Miniflare;
const entry = `
import { streamFrameResponse } from "./frame-response-stream.mjs";

const encode = (text) => new TextEncoder().encode(text);
const outcome = (promise) => promise.then(() => null, (error) => error.message);

export default {
  async fetch(request, env, ctx) {
    const scenario = new URL(request.url).pathname;
    const input = new IdentityTransformStream();
    const output = new FixedLengthStream(2);
    const controller = new AbortController();
    const sender = input.writable.getWriter();
    if (scenario === "/pre-abort") controller.abort(new Error("Frame request aborted"));
    const transfer = outcome(streamFrameResponse(input.readable, output.writable, 2, controller.signal));

    if (scenario === "/exact") {
      ctx.waitUntil((async () => {
        await sender.write(encode("{"));
        await sender.write(encode("}"));
        await sender.close();
        await transfer;
      })().catch(() => undefined));
      return new Response(output.readable, {
        headers: { "content-type": "application/json", "content-length": "2" }
      });
    }

    if (scenario === "/downstream-cancel") {
      const reason = new Error("Frame response disconnected");
      // Leave the pump waiting on a write with no downstream reader.
      await sender.write(encode("{"));
      await output.readable.cancel(reason);
      const failure = await transfer;
      return Response.json({ upstream: await outcome(sender.write(encode("}"))), transfer: failure });
    }

    if (scenario === "/abort-write") {
      // The input write resolves after the pump reads, before anyone reads the output.
      await sender.write(encode("{"));
      controller.abort(new Error("Frame request aborted"));
    }
    const downstream = outcome(new Response(output.readable).text());
    if (scenario === "/short" || scenario === "/overlong") {
      await outcome(sender.write(encode(scenario === "/short" ? "{" : "{}!")));
      await outcome(sender.close());
    } else if (scenario === "/upstream-error") {
      await sender.abort(new Error("Frame source failed"));
    } else if (scenario !== "/abort-write") {
      controller.abort(new Error("Frame request aborted"));
    }
    const failure = await transfer;
    return Response.json({
      transfer: failure,
      downstream: await downstream,
      upstream: await outcome(sender.write(encode("}"))),
    });
  }
};
`;

beforeAll(async () => {
  const source = await readFile(new URL("./frame-response-stream.ts", import.meta.url), "utf8");
  const module = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText;
  miniflare = new Miniflare({
    compatibilityDate: "2026-07-10",
    modules: [
      { type: "ESModule", path: "worker.mjs", contents: entry },
      { type: "ESModule", path: "frame-response-stream.mjs", contents: module },
    ],
    unsafeDirectSockets: [{ host: "127.0.0.1", port: 0, proxy: false }],
  });
  await miniflare.ready;
});

afterAll(async () => {
  await miniflare?.dispose();
});

async function scenario(path: string) {
  const response = await miniflare.dispatchFetch(`http://frame-worker${path}`, {
    signal: AbortSignal.timeout(5_000),
  });
  return response.json();
}

describe("native frame response streams in workerd", () => {
  it("relays IdentityTransformStream chunks with the fixed Content-Length over HTTP", async () => {
    const origin = await miniflare.unsafeGetDirectURL();
    const response = await fetch(new URL("/exact", origin), { signal: AbortSignal.timeout(5_000) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("2");
    expect(await response.text()).toBe("{}");
  });

  it.each([
    ["/short", /Incomplete frame response/],
    ["/overlong", /exceeds declared length/],
    ["/pre-abort", /Frame request aborted/],
    ["/abort-read", /Frame request aborted/],
    ["/abort-write", /Frame request aborted/],
    ["/upstream-error", /Frame source failed/],
  ])("propagates %s to the response body", async (path, error) => {
    expect(await scenario(path)).toMatchObject({
      transfer: expect.stringMatching(error),
      downstream: expect.stringMatching(error),
      upstream: expect.any(String),
    });
  });

  it("cancels the upstream if the client disconnects during a pending write", async () => {
    expect(await scenario("/downstream-cancel")).toMatchObject({
      upstream: expect.stringMatching("Frame response disconnected"),
      transfer: expect.any(String),
    });
  });
});
