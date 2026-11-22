import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { readChatContentEntry } from "./content-chat.server";

export const getChatContentArtifact = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ workspaceId: z.uuid(), entryId: z.uuid() }).strict().parse(input),
  )
  .handler(async ({ context, data }) => {
    if (
      data.workspaceId !== context.workspaceId ||
      context.workspaceSession.workspace.status !== "active"
    )
      throw new Error("This content is unavailable.");
    const entry = await readChatContentEntry(context.workspaceId, data.entryId);
    return {
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      revision: entry.revision,
      format: entry.document.format,
      duration:
        entry.document.format === "reel"
          ? entry.document.scenes.reduce((total, scene) => total + scene.duration, 0)
          : null,
      outline:
        entry.document.format === "reel"
          ? entry.document.scenes.map((scene) => ({
              heading: scene.title,
              text: scene.avatarScript || scene.caption,
              duration: scene.duration,
            }))
          : entry.document.slides.map((slide) => ({
              heading: slide.heading,
              text: slide.body,
              duration: null,
            })),
      summary: (entry.document.format === "reel"
        ? entry.document.scenes
            .map((scene) => scene.title)
            .filter(Boolean)
            .join(" · ")
        : entry.document.slides
            .map((slide) => slide.heading)
            .filter(Boolean)
            .join(" · ")
      ).slice(0, 1000),
    };
  });
