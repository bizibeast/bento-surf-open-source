import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { studioCarouselJobInput } from "./studio-carousel-job";
import { queueStudioCarouselJob, studioCarouselJobStatus } from "./studio-carousel-jobs.server";

function checkRenderWorkspace(requested: string, active: string, status: string) {
  if (requested !== active || status !== "active")
    throw new Error("Background rendering is unavailable in this workspace.");
}

export const getStudioCarouselJob = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => studioCarouselJobInput.parse(input))
  .handler(({ context, data }) => {
    checkRenderWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    return studioCarouselJobStatus(data, context.authUserId);
  });

export const startStudioCarouselJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => studioCarouselJobInput.parse(input))
  .handler(({ context, data }) => {
    checkRenderWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    return queueStudioCarouselJob(data, context.authUserId);
  });
