import { Buffer } from "node:buffer";
import { getMediaBucket, validateMediaObjectKey } from "./r2-storage.server";

export type McpFreeFileInput = {
  base64?: string;
  mediaKey?: string;
  fileName: string;
  mimeType?: string;
};

export async function readMcpFreeFile(
  workspaceId: string,
  input: McpFreeFileInput,
  maxBytes: number,
) {
  if (Boolean(input.base64) === Boolean(input.mediaKey))
    throw new Error("Provide exactly one of base64 or an owned Bento mediaKey.");
  if (input.fileName.length > 255 || !input.fileName.trim())
    throw new Error("Provide a valid file name.");

  if (input.base64) {
    const encoded = input.base64;
    if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error("The file is too large or is not valid base64.");
    const buffer = Buffer.from(encoded, "base64");
    if (
      !buffer.length ||
      buffer.length > maxBytes ||
      buffer.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
    )
      throw new Error("The file is too large or is not valid base64.");
    return {
      bytes: new Uint8Array(buffer),
      mimeType: input.mimeType ?? "application/octet-stream",
      fileName: input.fileName,
    };
  }

  const key = input.mediaKey!;
  if (!validateMediaObjectKey(key) || !key.startsWith(`users/${workspaceId}/`))
    throw new Error("The media file belongs to another workspace.");
  const object = await getMediaBucket().get(key);
  if (!object || object.size <= 0 || object.size > maxBytes)
    throw new Error("The media file is missing or too large.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size) throw new Error("The media file changed during reading.");
  return {
    bytes,
    mimeType: object.httpMetadata?.contentType ?? "application/octet-stream",
    fileName: input.fileName,
  };
}
