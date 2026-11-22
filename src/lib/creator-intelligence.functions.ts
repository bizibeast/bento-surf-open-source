import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { creatorIntelligencePreferencesSchema } from "./creator-intelligence";
import {
  getCreatorIntelligence,
  saveCreatorIntelligencePreferences,
} from "./creator-intelligence.server";

const workspaceInput = z.object({ workspaceId: z.string().uuid() }).strict();

export const readCreatorIntelligence = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => workspaceInput.parse(input))
  .handler(async ({ context, data }) => {
    if (
      context.workspaceId !== data.workspaceId ||
      context.workspaceSession.workspace.status !== "active"
    )
      return null;
    return getCreatorIntelligence({ userId: context.workspaceId });
  });

export const updateCreatorIntelligencePreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    workspaceInput
      .extend({
        preferences: creatorIntelligencePreferencesSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    if (
      context.workspaceId !== data.workspaceId ||
      context.workspaceSession.workspace.status !== "active"
    )
      throw new Error("Creator intelligence is unavailable for this workspace.");
    return saveCreatorIntelligencePreferences(context.workspaceId, data.preferences);
  });
