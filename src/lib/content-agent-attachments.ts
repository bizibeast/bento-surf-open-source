import { z } from "zod";

export const AGENT_ATTACHMENT_LIMIT = 4;
export const AGENT_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const AGENT_ATTACHMENT_ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,application/pdf,text/plain,text/markdown,text/csv,.md,.txt,.csv";
export const agentAttachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  key: z.string().max(500),
  mimeType: z.string().max(100),
  size: z.number().int().positive(),
  url: z
    .string()
    .url()
    .regex(/^https?:\/\//)
    .nullable(),
  mediaId: z.string().uuid().nullable(),
  note: z.string().max(500).optional(),
});
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>;
export function agentAttachmentKind(file: Pick<File, "name" | "type" | "size">) {
  if (/^image\/(jpeg|png|webp|gif)$/.test(file.type)) return "image" as const;
  if (/^video\/(mp4|webm)$/.test(file.type)) return "video" as const;
  if (/\.(pdf|txt|md|csv)$/i.test(file.name) && file.size <= AGENT_DOCUMENT_MAX_BYTES)
    return "agent_file" as const;
  throw new Error(
    "Attach a JPEG, PNG, WebP, GIF, MP4 or WebM, or a PDF, TXT, Markdown or CSV file under 8 MB.",
  );
}
