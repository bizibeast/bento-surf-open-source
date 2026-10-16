import { z } from "zod";

// Browser tools use the 256 KiB server-function transport, not remote MCP.
// Leave room for base64 expansion and the JSON/serialization envelope.
export const WEBMCP_INLINE_MEDIA_BYTES = 128 * 1024;
export const WEBMCP_INLINE_BASE64_CHARS = 4 * Math.ceil(WEBMCP_INLINE_MEDIA_BYTES / 3);
const uploadLimitMessage =
  "Browser inline uploads accept files up to 128 KiB. Use begin_media_upload and binary chunks for larger files, or Bento's attachment picker.";

export const webMcpUploadInputSchema = z
  .object({
    sourceUrl: z.string().url().optional(),
    base64: z
      .string()
      .max(WEBMCP_INLINE_BASE64_CHARS, uploadLimitMessage)
      .refine((value) => {
        const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        return Math.floor((value.length * 3) / 4) - padding <= WEBMCP_INLINE_MEDIA_BYTES;
      }, uploadLimitMessage)
      .optional(),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(100),
    kind: z.enum(["image", "video", "audio", "file"]),
  })
  .strict()
  .refine((value) => Boolean(value.sourceUrl) !== Boolean(value.base64), {
    message: "Provide exactly one of sourceUrl or base64.",
  });
