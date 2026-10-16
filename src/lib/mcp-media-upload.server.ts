import { z } from "zod-v4";
import { handleR2StorageRequest, sanitizeFileExtension } from "./r2-storage.server";
import { workspaceCookieSigningKey } from "./workspace-session.server";

export const MCP_MEDIA_UPLOAD_PATH = "/api/mcp-media-upload";
export const MCP_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1000;

export function mcpMediaOrigin(origin: string) {
  return new URL(process.env.VITE_APP_URL || origin).origin;
}

export const beginMediaUploadSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  kind: z.enum(["image", "video", "audio", "file"]),
  size: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024 * 1024)
    .describe(
      "Exact original file size in bytes. Bento checks the plan and remaining storage before creating the upload.",
    ),
});

const ticketSchema = beginMediaUploadSchema.extend({
  purpose: z.literal("bento-mcp-media-v1"),
  userId: z.uuid(),
  key: z.string().min(1).max(1024),
  uploadId: z.string().min(1).max(1024),
  origin: z.url(),
  expiresAt: z.number().int(),
});
type UploadTicket = z.infer<typeof ticketSchema>;

function encode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function signingKey() {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(workspaceCookieSigningKey()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signTicket(ticket: UploadTicket, key: CryptoKey) {
  const payload = encode(new TextEncoder().encode(JSON.stringify(ticket)));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

async function verifyTicket(request: Request): Promise<UploadTicket | null> {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ") || header.length > 8192) return null;
  const [payload, signature, extra] = header.slice(7).split(".");
  if (!payload || !signature || extra) return null;
  try {
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(),
        decode(signature),
        new TextEncoder().encode(payload),
      ))
    )
      return null;
    const ticket = ticketSchema.parse(JSON.parse(new TextDecoder().decode(decode(payload))));
    if (ticket.expiresAt <= Date.now() || ticket.origin !== new URL(request.url).origin)
      return null;
    return ticket;
  } catch {
    return null;
  }
}

export async function beginMcpMediaUpload(
  userId: string,
  origin: string,
  raw: z.input<typeof beginMediaUploadSchema>,
) {
  origin = mcpMediaOrigin(origin);
  const input = beginMediaUploadSchema.parse(raw);
  const secret = await signingKey(); // Fail before creating an unfinished R2 upload.
  const env = globalThis.__env__;
  if (!env?.MEDIA_BUCKET) throw new Error("Bento media storage is unavailable.");
  const extension = sanitizeFileExtension(input.fileName.split(".").pop()?.toLowerCase() || "");
  if (!extension) throw new Error("The media filename needs a supported extension.");
  const response = await handleR2StorageRequest(
    new Request(`${origin}/api/storage/upload?action=mpu-create`, {
      method: "POST",
      headers: {
        "Content-Type": input.mimeType,
        "X-Bento-File-Extension": extension,
        "X-Bento-File-Name": encodeURIComponent(input.fileName),
        "X-Bento-File-Size": String(input.size),
        "X-Bento-Upload-Kind": input.kind,
      },
    }),
    env,
    { waitUntil: () => undefined },
    { authenticate: async () => userId },
  );
  const result = (await response?.json()) as
    { key?: string; uploadId?: string; error?: string } | undefined;
  if (!response?.ok || !result?.key || !result.uploadId)
    throw new Error(result?.error || "The upload could not be started.");
  const expiresAt = Date.now() + UPLOAD_LIFETIME_MS;
  const ticket: UploadTicket = {
    ...input,
    userId,
    key: result.key,
    uploadId: result.uploadId,
    origin: new URL(origin).origin,
    purpose: "bento-mcp-media-v1",
    expiresAt,
  };
  const url = `${ticket.origin}${MCP_MEDIA_UPLOAD_PATH}`;
  return {
    key: ticket.key,
    uploadUrl: url,
    headers: { Authorization: `Bearer ${await signTicket(ticket, secret)}` },
    expiresAt: new Date(expiresAt).toISOString(),
    partSize: MCP_UPLOAD_PART_BYTES,
    partCount: Math.ceil(input.size / MCP_UPLOAD_PART_BYTES),
    instructions:
      "Keep the upload credential private. Read the original file with your file/HTTP tools. PUT each raw binary chunk to uploadUrl?partNumber=N (1-based), using the returned Authorization header and Content-Type: application/octet-stream. Chunks must be partSize bytes except the last. Save every returned {partNumber,etag}. POST {parts:[...]} as application/json to uploadUrl with the same Authorization header to complete. Completion returns {media} for create_social_post. DELETE uploadUrl with the same header cancels only this unfinished upload. Retry a failed part at most twice using the same partNumber. Do not compress, put the full video in MCP JSON, expose this credential, or create a post before completion. The token expires in two hours and cannot access other files or workspace actions.",
  };
}

/** A short-lived capability for exactly one upload, never an account access token. */
export async function handleMcpMediaUpload(
  request: Request,
  env: Env | undefined,
  context: Pick<ExecutionContext, "waitUntil"> = { waitUntil: () => undefined },
) {
  const json = (body: unknown, status: number) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!["PUT", "POST", "DELETE"].includes(request.method))
    return json({ error: "Use PUT for a part, POST to complete, or DELETE to cancel." }, 405);
  const ticket = await verifyTicket(request);
  if (!ticket)
    return json(
      {
        error:
          "Upload credential is invalid or expired. Start a new upload with begin_media_upload.",
      },
      401,
    );
  const action =
    request.method === "PUT"
      ? "mpu-uploadpart"
      : request.method === "POST"
        ? "mpu-complete"
        : "mpu-abort";
  const url = new URL("/api/storage/upload", ticket.origin);
  url.searchParams.set("action", action);
  url.searchParams.set("key", ticket.key);
  url.searchParams.set("uploadId", ticket.uploadId);
  const headers = new Headers({
    "content-type": request.method === "PUT" ? "application/octet-stream" : "application/json",
  });
  if (!env?.MEDIA_BUCKET) return json({ error: "Bento media storage is unavailable." }, 503);
  if (request.headers.has("content-length"))
    headers.set("content-length", request.headers.get("content-length")!);
  if (request.method === "PUT") {
    const partNumber = Number(new URL(request.url).searchParams.get("partNumber"));
    const count = Math.ceil(ticket.size / MCP_UPLOAD_PART_BYTES);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count)
      return json({ error: "Invalid part number." }, 400);
    url.searchParams.set("partNumber", String(partNumber));
    headers.set(
      "x-bento-file-size",
      String(
        partNumber === count
          ? ticket.size - (count - 1) * MCP_UPLOAD_PART_BYTES
          : MCP_UPLOAD_PART_BYTES,
      ),
    );
  }
  const response = await handleR2StorageRequest(
    new Request(url, {
      method: request.method === "DELETE" ? "POST" : request.method,
      headers,
      body: request.method === "DELETE" ? undefined : request.body,
      // Required by Node's Fetch implementation; Cloudflare streams this unchanged.
      ...{ duplex: "half" },
    }),
    env,
    context,
    { authenticate: async () => ticket.userId },
  );
  if (!response) return json({ error: "Upload route is unavailable." }, 503);
  if (request.method !== "POST" || !response.ok) return response;
  const result = (await response.json()) as { key: string; publicUrl: string; size: number };
  return json(
    {
      media: {
        key: result.key,
        url: result.publicUrl,
        size: result.size,
        name: ticket.fileName,
        mimeType: ticket.mimeType,
      },
    },
    201,
  );
}
