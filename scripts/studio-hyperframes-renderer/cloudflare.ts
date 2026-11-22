import { Container, getContainer } from "@cloudflare/containers";
import { routeRendererRequest, rendererExecutionRequest, rendererOutput } from "./bridge";
import { streamFrameResponse } from "./frame-response-stream";

const FRAME_RESPONSE_TRANSFER_TIMEOUT_MS = 30_000;

export class HyperframesRenderer extends Container<HyperframesEnv> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
  envVars: Record<string, string> = {};
  private busy = false;

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const output = rendererOutput(path);
    if (request.method !== "POST" || !output) return new Response(null, { status: 404 });
    if (this.busy) return new Response(null, { status: 503 });
    this.busy = true;
    let streaming = false;
    try {
      // A Worker restart must not reuse a still-running execution from a previous request.
      await this.destroy();
      const execution = rendererExecutionRequest(request);
      this.envVars = execution.env;
      const response = await this.containerFetch(execution.request);
      if (!response.ok) {
        await response.body?.cancel();
        return new Response(null, { status: response.status });
      }
      const declared = response.headers.get("content-length") ?? "";
      const length = Number(declared);
      if (
        response.headers.get("content-type") !== output.contentType ||
        !response.body ||
        !/^\d+$/.test(declared) ||
        length <= 0 ||
        length > output.limit
      ) {
        await response.body?.cancel();
        return new Response(null, { status: 502 });
      }
      let size = 0;
      const stream =
        path === "/frames"
          ? new FixedLengthStream(length)
          : new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                size += chunk.byteLength;
                if (size > length) {
                  controller.error(new Error("Renderer output exceeds declared length"));
                  return;
                }
                controller.enqueue(chunk);
              },
              flush(controller) {
                if (size !== length) controller.error(new Error("Incomplete renderer output"));
              },
            });
      streaming = true;
      // workerd cannot pipe the container's native IdentityTransformStream to FixedLengthStream.
      const transfer =
        path === "/frames"
          ? streamFrameResponse(
              response.body,
              stream.writable,
              length,
              AbortSignal.any([
                request.signal,
                AbortSignal.timeout(FRAME_RESPONSE_TRANSFER_TIMEOUT_MS),
              ]),
            )
          : response.body.pipeTo(stream.writable, { signal: request.signal });
      this.ctx.waitUntil(
        transfer
          .catch(() => undefined)
          .finally(async () => {
            await this.destroy().catch(() => undefined);
            this.busy = false;
          }),
      );
      return new Response(stream.readable, {
        headers: {
          "content-type": output.contentType,
          "content-length": String(length),
          "cache-control": "no-store",
        },
      });
    } finally {
      // Destroy after every job, including failed starts, so no process or filesystem survives.
      if (!streaming) {
        await this.destroy().catch(() => undefined);
        this.busy = false;
      }
    }
  }
}
export default {
  fetch(request: Request, env: HyperframesEnv) {
    return routeRendererRequest(
      request,
      { enabled: env.RENDERER_ENABLED, token: env.STUDIO_REEL_RENDERER_TOKEN },
      (slot, request) => getContainer(env.HYPERFRAMES_RENDERER, slot).fetch(request),
    );
  },
};
