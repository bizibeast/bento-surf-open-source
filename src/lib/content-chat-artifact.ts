import { z } from "zod";

export const chatArtifactSchema = z.object({ entryId: z.uuid() });
export type ChatArtifact = z.infer<typeof chatArtifactSchema>;
const creationTools = new Set([
  "save_content_studio_project",
  "revise_content_studio_copy",
  "create_content_from_reference",
  "prepare_reel_production",
  "get_reel_production",
  "get_content_studio_projects",
]);
export function isChatCreationTool(tool: string) {
  return creationTools.has(tool);
}
/** Extract only an owned receipt's identifier, never send its document/code to the UI. */
export function chatArtifactFromReceipt(tool: string, receipt: unknown): ChatArtifact | undefined {
  if (!isChatCreationTool(tool) || !receipt || typeof receipt !== "object") return;
  const wrapped = receipt as { result?: unknown };
  const value = (
    wrapped.result && typeof wrapped.result === "object" ? wrapped.result : receipt
  ) as { entry?: { id?: unknown }; production?: { entryId?: unknown } };
  const parsed = chatArtifactSchema.safeParse({
    entryId: value.entry?.id ?? value.production?.entryId,
  });
  return parsed.success ? parsed.data : undefined;
}
export function chatCreationSummary(args: Record<string, unknown>) {
  const document =
    args.document && typeof args.document === "object"
      ? (args.document as Record<string, unknown>)
      : {};
  const draft =
    args.draft && typeof args.draft === "object" ? (args.draft as Record<string, unknown>) : {};
  const copy = Array.isArray(draft.scenes)
    ? draft.scenes
    : Array.isArray(draft.slides)
      ? draft.slides
      : [];
  const revisedCopy = copy
    .flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      return [value.speakerScript || value.title || value.heading, value.body].filter(
        (text): text is string => typeof text === "string" && Boolean(text.trim()),
      );
    })
    .join("\n");
  return {
    title:
      typeof args.title === "string"
        ? args.title
        : typeof draft.title === "string"
          ? draft.title
          : "Your content",
    summary: revisedCopy
      ? revisedCopy.slice(0, 1000)
      : typeof args.prompt === "string"
        ? args.prompt.slice(0, 1000)
        : typeof document.caption === "string"
          ? document.caption.slice(0, 1000)
          : typeof document.title === "string"
            ? document.title
            : "Create an original draft using your preferences. Review the video here when it is ready.",
  };
}
