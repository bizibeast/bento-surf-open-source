// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  upstream: vi.fn(),
  destroy: vi.fn(),
  waits: [] as Promise<unknown>[],
}));
vi.mock("@cloudflare/containers", () => ({
  Container: class {
    ctx = { waitUntil: (promise: Promise<unknown>) => fixture.waits.push(promise) };
    containerFetch(request: Request) {
      return fixture.upstream(request);
    }
    destroy() {
      return fixture.destroy();
    }
  },
  getContainer: vi.fn(),
}));
import { HyperframesRenderer } from "./cloudflare";
const request = (path = "/render", signal?: AbortSignal) =>
  new Request(new URL(path, "https://renderer"), {
    method: "POST",
    headers: {
      authorization: "Bearer shared-bridge-secret",
      "content-type": "multipart/form-data",
    },
    body: "fixture",
    signal,
  });
const video = () =>
  new Response("MP4 fixture", { headers: { "content-type": "video/mp4", "content-length": "11" } });
const json = (length = 2) =>
  new Response("{}", {
    headers: { "content-type": "application/json", "content-length": String(length) },
  });
const fixedLength = vi.fn();
class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    fixedLength(length);
    let size = 0;
    super({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > length) controller.error(new Error("Fixed-length body overflow"));
        else controller.enqueue(chunk);
      },
      flush(controller) {
        if (size !== length) controller.error(new Error("Fixed-length body truncated"));
      },
    });
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.waits = [];
  fixture.destroy.mockResolvedValue(undefined);
  fixture.upstream.mockResolvedValue(video());
  vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);
});
afterEach(() => vi.unstubAllGlobals());
describe("on-demand execution lifecycle", () => {
  it("keeps the active render isolated and destroys it once the response finishes", async () => {
    const worker = new HyperframesRenderer({} as never, {} as never);
    const first = await worker.fetch(request());
    expect((await worker.fetch(request())).status).toBe(503);
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
    const forwarded = fixture.upstream.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("authorization")).not.toBe("Bearer shared-bridge-secret");
    expect(forwarded.headers.get("authorization")).toBe(
      `Bearer ${worker.envVars.STUDIO_REEL_RENDERER_TOKEN}`,
    );
    expect(fixture.destroy).toHaveBeenCalledTimes(1);
    expect(await first.text()).toBe("MP4 fixture");
    await Promise.all(fixture.waits);
    expect(fixture.destroy).toHaveBeenCalledTimes(2);
    fixture.upstream.mockResolvedValue(video());
    const second = await worker.fetch(request());
    await second.text();
    await Promise.all(fixture.waits);
    expect(fixture.upstream.mock.calls[1][0].headers.get("authorization")).not.toBe(
      forwarded.headers.get("authorization"),
    );
    expect(fixture.destroy).toHaveBeenCalledTimes(4);
    expect(fixedLength).not.toHaveBeenCalled();
  });
  it("destroys failed starts and invalid outputs before releasing the execution slot", async () => {
    const worker = new HyperframesRenderer({} as never, {} as never);
    fixture.upstream.mockRejectedValueOnce(Error("Start failed"));
    await expect(worker.fetch(request())).rejects.toThrow("Start failed");
    expect(fixture.destroy).toHaveBeenCalledTimes(2);
    fixture.upstream.mockResolvedValueOnce(
      new Response("invalid", { headers: { "content-type": "text/plain" } }),
    );
    expect((await worker.fetch(request())).status).toBe(502);
    expect(fixture.destroy).toHaveBeenCalledTimes(4);
  });
  it("streams only the endpoint-specific format within its declared size bound", async () => {
    const worker = new HyperframesRenderer({} as never, {} as never);
    fixture.upstream.mockResolvedValueOnce(json());
    const frames = await worker.fetch(request("/frames"));
    expect(frames.status).toBe(200);
    expect(frames.headers.get("content-type")).toBe("application/json");
    expect(frames.headers.get("cache-control")).toBe("no-store");
    expect(frames.headers.get("content-length")).toBe("2");
    expect(fixedLength).toHaveBeenCalledExactlyOnceWith(2);
    expect(new URL(fixture.upstream.mock.calls[0][0].url).pathname).toBe("/frames");
    expect((await worker.fetch(request())).status).toBe(503);
    expect(await frames.text()).toBe("{}");
    await Promise.all(fixture.waits);
    expect(fixture.destroy).toHaveBeenCalledTimes(2);

    fixture.upstream.mockResolvedValueOnce(json());
    expect((await worker.fetch(request())).status).toBe(502);
    fixture.upstream.mockResolvedValueOnce(video());
    expect((await worker.fetch(request("/frames"))).status).toBe(502);
    fixture.upstream.mockResolvedValueOnce(json(12 * 1024 * 1024 + 1));
    expect((await worker.fetch(request("/frames"))).status).toBe(502);
    expect(fixture.destroy).toHaveBeenCalledTimes(8);
  });

  it("rejects short and oversized bodies and destroys each execution", async () => {
    const worker = new HyperframesRenderer({} as never, {} as never);
    for (const length of [3, 1]) {
      fixture.upstream.mockResolvedValueOnce(json(length));
      const response = await worker.fetch(request("/frames"));
      await expect(response.text()).rejects.toThrow();
      await Promise.all(fixture.waits);
    }
    expect(fixture.destroy).toHaveBeenCalledTimes(4);

    // A bodyless success with apparently valid headers cannot become a stream.
    fixture.upstream.mockResolvedValueOnce(
      new Response(null, {
        headers: { "content-type": "application/json", "content-length": "2" },
      }),
    );
    expect((await worker.fetch(request("/frames"))).status).toBe(502);
    expect(fixture.destroy).toHaveBeenCalledTimes(6);
  });

  it("cancels the frame source on abort and holds the slot until destruction completes", async () => {
    const worker = new HyperframesRenderer({} as never, {} as never);
    const controller = new AbortController();
    const cancel = vi.fn();
    let finishDestroy!: () => void;
    const destruction = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    fixture.destroy.mockResolvedValueOnce(undefined).mockReturnValueOnce(destruction);
    fixture.upstream.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json", "content-length": "2" },
      }),
    );

    const response = await worker.fetch(request("/frames", controller.signal));
    const consumed = expect(response.text()).rejects.toThrow("Frame request aborted");
    const reason = new Error("Frame request aborted");
    controller.abort(reason);
    try {
      await consumed;
      await vi.waitFor(() => expect(fixture.destroy).toHaveBeenCalledTimes(2));
      expect(cancel).toHaveBeenCalledWith(reason);
      expect((await worker.fetch(request())).status).toBe(503);
    } finally {
      finishDestroy();
    }
    await Promise.all(fixture.waits);

    const next = await worker.fetch(request());
    expect(await next.text()).toBe("MP4 fixture");
    await Promise.all(fixture.waits);
    expect(fixture.destroy).toHaveBeenCalledTimes(4);
  });

  it("starts the frame transfer deadline after headers and releases a stalled source", async () => {
    vi.useFakeTimers();
    const expired = new DOMException("Frame transfer deadline exceeded", "TimeoutError");
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(expired), ms);
      return controller.signal;
    });
    try {
      const worker = new HyperframesRenderer({} as never, {} as never);
      const cancel = vi.fn();
      let sendHeaders!: (response: Response) => void;
      fixture.upstream.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          sendHeaders = resolve;
        }),
      );
      const pending = worker.fetch(request("/frames"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(timeout).not.toHaveBeenCalled();
      sendHeaders(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "application/json", "content-length": "2" },
        }),
      );
      const response = await pending;
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
      const consumed = expect(response.text()).rejects.toThrow(expired.message);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(cancel).not.toHaveBeenCalled();
      expect(fixture.destroy).toHaveBeenCalledTimes(1);
      expect((await worker.fetch(request())).status).toBe(503);

      await vi.advanceTimersByTimeAsync(1);
      await consumed;
      await Promise.all(fixture.waits);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(expired);
      expect(fixture.destroy).toHaveBeenCalledTimes(2);

      const next = await worker.fetch(request());
      expect(await next.text()).toBe("MP4 fixture");
      await Promise.all(fixture.waits);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(fixture.destroy).toHaveBeenCalledTimes(4);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
