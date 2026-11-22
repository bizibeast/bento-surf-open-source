import {
  VIDEO_FRAME_INPUT_LIMIT,
  VIDEO_FRAME_RESPONSE_LIMIT,
} from "../../src/lib/video-frame-grid";

const INPUT_LIMIT = VIDEO_FRAME_INPUT_LIMIT + 256 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const renderOutput = { contentType: "video/mp4", limit: 32 * 1024 * 1024 };
const framesOutput = { contentType: "application/json", limit: VIDEO_FRAME_RESPONSE_LIMIT };

export function rendererOutput(path: string) {
  if (path === "/render") return renderOutput;
  if (path === "/frames") return framesOutput;
  return undefined;
}

/** The long-lived bridge token stays in Workers; each execution receives a disposable token. */
export function rendererExecutionRequest(request: Request) {
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const headers = new Headers({
    "content-type": request.headers.get("content-type") || "",
    authorization: `Bearer ${token}`,
  });
  return { request: new Request(request, { headers }), env: { STUDIO_REEL_RENDERER_TOKEN: token } };
}

/** Authentication precedes every container lookup/start. Only two fixed instance names can exist. */
export async function routeRendererRequest(
  request: Request,
  configuration: { enabled: string; token?: string },
  forward: (slot: string, request: Request) => Promise<Response>,
) {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !rendererOutput(path))
    return new Response(null, { status: 404 });
  const token = configuration.token;
  if (configuration.enabled !== "true" || !token || !/^[A-Za-z0-9_-]{32,256}$/.test(token))
    return new Response(null, { status: 503 });
  const authorization = request.headers.get("authorization") || "";
  if (authorization.length !== token.length + 7) return new Response(null, { status: 401 });
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [expected, provided] = await Promise.all([
    digest(`Bearer ${token}`),
    digest(authorization),
  ]);
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected[index] ^ provided[index];
  if (difference !== 0) return new Response(null, { status: 401 });
  const workspace = request.headers.get("x-bento-workspace-id") || "";
  if (!uuid.test(workspace)) return new Response(null, { status: 422 });
  const declared = Number(request.headers.get("content-length"));
  if (declared > INPUT_LIMIT) return new Response(null, { status: 413 });
  let size = 0;
  const body = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > INPUT_LIMIT) {
          controller.error(new Error("Renderer input limit exceeded"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const headers = new Headers({
    authorization,
    "content-type": request.headers.get("content-type") || "",
  });
  const forwarded = new Request(new URL(path, "http://renderer"), {
    method: "POST",
    headers,
    body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit);
  const slot = `render-slot-${parseInt(workspace.slice(-1), 16) % 2}`;
  return forward(slot, forwarded);
}
