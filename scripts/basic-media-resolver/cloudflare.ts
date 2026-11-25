import { Container } from "@cloudflare/containers";
import { readBoundedBytes } from "../../src/lib/media-stream";

import { nextAttempt, nextTransfer, TRANSFER_BLOCK_BYTES, type Attempts } from "./limits";
import serviceSource from "./service.py";
const MAX_BYTES = 5 * 1024 ** 3;

type ServiceEnv = BasicMediaEnv & { BASIC_MEDIA_TOKEN?: string; YOUTUBE_COOKIE_JAR?: string };

function equal(a: string, b: string) {
  let n = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    n |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return n === 0;
}
function authorized(request: Request, env: ServiceEnv) {
  const token = env.BASIC_MEDIA_TOKEN?.trim();
  return Boolean(
    token &&
    token.length >= 32 &&
    equal(request.headers.get("authorization") || "", `Bearer ${token}`),
  );
}
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export class BasicMedia extends Container<ServiceEnv> {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
  envVars: Record<string, string> = {};
  // Ship the reviewed service with the Worker, using the existing image's pinned
  // Python/yt-dlp runtime. No image rebuild, registry grant or new server is needed.
  entrypoint = [
    "/opt/media-python/bin/python",
    "-c",
    [
      "import base64,hashlib,os,pathlib,runpy,shutil,sys",
      "os.umask(0o077)",
      `source=base64.b64decode(${JSON.stringify(btoa(Array.from(new TextEncoder().encode(serviceSource), (b) => String.fromCharCode(b)).join("")))})`,
      "root=pathlib.Path('/tmp')/('bento-service-'+hashlib.sha256(source).hexdigest()[:16])",
      "root.mkdir(mode=0o700,exist_ok=True)",
      "script=root/'service.py'",
      "script.write_bytes(source)",
      "shutil.copyfile('/opt/basic-media/native_tiktok.py',root/'native_tiktok.py')",
      "sys.path.insert(0,str(root))",
      "runpy.run_path(str(script),run_name='__main__')",
    ].join(";"),
  ];
  private busy = false;
  private internalToken: string | null = null;

  private async reserve() {
    const now = new Date().toISOString();
    return this.ctx.storage.transaction(async (tx) => {
      const next = nextAttempt(await tx.get<Attempts>("attempts"), now);
      if (!next) return false;
      await tx.put("attempts", next);
      return true;
    });
  }

  private async reserveTransfer() {
    return this.ctx.storage.transaction(async (tx) => {
      const next = nextTransfer(await tx.get<Attempts>("transfer"), new Date().toISOString());
      if (!next) throw new Error("Transfer budget exhausted");
      await tx.put("transfer", next);
    });
  }

  override async fetch(request: Request) {
    if (!authorized(request, this.env)) return json({ code: "unauthorized" }, 401);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health")
      return json({
        ok: true,
        attempts: (await this.ctx.storage.get<Attempts>("attempts")) ?? null,
        transfer: (await this.ctx.storage.get<Attempts>("transfer")) ?? null,
      });
    if (request.method === "POST" && path === "/restart") {
      if (this.busy) return json({ code: "error.api.basic_media.busy" }, 429);
      await this.restart();
      return json({ ok: true });
    }
    const resolve = request.method === "POST" && path === "/resolve";
    const stats = request.method === "POST" && path === "/stats";
    const stream = request.method === "GET" && /^\/stream\/[a-f0-9]{32}$/u.test(path);
    if (!resolve && !stream && !stats) return json({ code: "not_found" }, 404);
    if (this.busy) return json({ code: "error.api.basic_media.busy" }, 429);
    this.busy = true;
    let streaming = false;
    const heartbeat = setInterval(() => this.renewActivityTimeout(), 30_000);
    try {
      if (!(await this.reserve())) return json({ code: "error.api.basic_media.limit" }, 429);
      if (stats) {
        const revision = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serviceSource)),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        if ((await this.ctx.storage.get<string>("serviceRevision")) !== revision) {
          // Worker updates can retain an already-running container. The busy
          // gate above excludes active streams; refresh once per source version.
          await this.destroy();
          await this.ctx.storage.delete("containerToken");
          this.internalToken = null;
          this.envVars = {};
          await this.ctx.storage.put("serviceRevision", revision);
        }
      }
      if (stream && !this.ctx.container?.running) {
        return json({ code: "expired" }, 404);
      }
      if (!this.internalToken) {
        const saved = await this.ctx.storage.get<string>("containerToken");
        if (!saved && stream) return json({ code: "expired" }, 404);
        if (!saved) await this.destroy();
        this.internalToken = saved || crypto.randomUUID() + crypto.randomUUID();
        if (!saved) await this.ctx.storage.put("containerToken", this.internalToken);
        this.envVars = {
          INTERNAL_TOKEN: this.internalToken,
          ...(this.env.YOUTUBE_COOKIE_JAR
            ? { YOUTUBE_COOKIE_JAR: this.env.YOUTUBE_COOKIE_JAR }
            : {}),
        };
      }
      if (stream) {
        try {
          await this.reserveTransfer();
        } catch {
          return json({ code: "error.api.basic_media.limit" }, 429);
        }
      }
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${this.internalToken}`);
      const body = resolve || stats ? await readBoundedBytes(request, 4096) : undefined;
      if (body) headers.set("content-length", String(body.byteLength));
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(stats ? 43_000 : resolve ? 48_000 : 30 * 60_000),
      ]);
      const forwarded = new Request(request.url, {
        method: request.method,
        headers,
        body: body ? (new Uint8Array(body).buffer as ArrayBuffer) : undefined,
        signal,
      });
      const response = await this.containerFetch(forwarded);
      if (stats)
        console.info("Private metadata runtime response", {
          status: response.status,
          revision: response.headers.get("x-bento-service-revision") ?? "image-default",
        });
      if (!response.ok || !stream || !response.body) return response;
      const type = response.headers.get("content-type");
      if (type !== "video/mp4" && type !== "audio/mpeg") {
        await response.body.cancel();
        return json({ code: "error.api.fetch.fail" }, 502);
      }
      let prepaidBytes = TRANSFER_BLOCK_BYTES;
      const reserveTransfer = () => this.reserveTransfer();
      const bounded = new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > MAX_BYTES) controller.error(new Error("Media byte ceiling"));
          else {
            while (bytes > prepaidBytes) {
              await reserveTransfer();
              prepaidBytes += TRANSFER_BLOCK_BYTES;
            }
            controller.enqueue(chunk);
          }
        },
      });
      let bytes = 0;
      streaming = true;
      this.ctx.waitUntil(
        response.body
          .pipeTo(bounded.writable, { signal })
          .catch(() => undefined)
          .finally(() => {
            clearInterval(heartbeat);
            this.busy = false;
          }),
      );
      return new Response(bounded.readable, { status: response.status, headers: response.headers });
    } catch (error) {
      console.warn("Private media transport failed", {
        operation: stats ? "metadata" : resolve ? "resolve" : "stream",
        name: error instanceof Error ? error.name : "unknown",
      });
      await this.destroy().catch(() => undefined);
      this.internalToken = null;
      return json({ code: stats ? "error.api.metadata.transport" : "error.api.fetch.fail" }, 502);
    } finally {
      if (!streaming) {
        clearInterval(heartbeat);
        this.busy = false;
      }
    }
  }

  /** Explicit credential rotation invalidates jobs; ordinary stop events must not race a new job. */
  async restart() {
    this.busy = true;
    try {
      await this.destroy();
      await this.ctx.storage.delete("containerToken");
      this.internalToken = null;
      this.envVars = {};
    } finally {
      this.busy = false;
    }
  }

  override async onStop() {
    // The event can belong to an earlier process. Request finalizers own the busy
    // flag; a persisted internal token survives DO eviction while the container runs.
  }
}

export default {
  async fetch(request: Request, env: ServiceEnv) {
    if (String(env.BASIC_MEDIA_ENABLED) !== "true") return json({ code: "disabled" }, 503);
    if (!authorized(request, env)) return json({ code: "unauthorized" }, 401);
    const instance = env.BASIC_MEDIA.get(env.BASIC_MEDIA.idFromName("public-media-single-slot"));
    return instance.fetch(request);
  },
};
