import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { studioSaveInputSchema, studioSchedulerDraftSchema } from "./content-studio";
import { saveStudioSchedulerDraft } from "./content-studio-scheduler.server";
import {
  deleteStudioWorkspaceEntry,
  getStudioWorkspaceBrand,
  listContentStudioEntriesForWorkspace,
  listStudioWorkspaceMedia,
  saveContentStudioEntryForWorkspace,
} from "./content-studio.server";

const workspaceInput = z.object({ workspaceId: z.string().uuid() });
export const getContentStudioHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => workspaceInput.extend({ entryId: z.uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    checkWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    const { loadContentCreationHistory } = await import("./content-creation-history.server");
    return loadContentCreationHistory(context.workspaceId, data.entryId);
  });

function checkWorkspace(requested: string, active: string, status: string) {
  if (requested !== active || status !== "active")
    throw new Error("Content Studio is unavailable for this workspace.");
}

export const loadContentStudio = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => workspaceInput.parse(input))
  .handler(async ({ context, data }) => {
    checkWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    const entries = await listContentStudioEntriesForWorkspace(context.workspaceId);
    const brand = await getStudioWorkspaceBrand(context.workspaceId);
    return { entries, brand };
  });

export const listContentStudioMedia = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    workspaceInput
      .extend({
        page: z.number().int().min(0).max(100),
        selectedIds: z.array(z.string().uuid()).max(22),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    checkWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    return listStudioWorkspaceMedia(context.workspaceId, data.page, data.selectedIds);
  });

export const openStudioSchedulerDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => studioSchedulerDraftSchema.parse(input))
  .handler(async ({ context, data }) => {
    checkWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    return saveStudioSchedulerDraft(data);
  });

export const saveContentStudioEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => studioSaveInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    checkWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    return saveContentStudioEntryForWorkspace(context.workspaceId, data);
  });

export const deleteContentStudioEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    workspaceInput
      .extend({
        id: z.string().uuid(),
        revision: z.number().int().positive(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    checkWorkspace(
      data.workspaceId,
      context.workspaceId,
      context.workspaceSession.workspace.status,
    );
    return deleteStudioWorkspaceEntry(context.workspaceId, data.id, data.revision);
  });
