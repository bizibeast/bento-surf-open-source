import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireContentWorkspace } from "./content-access.server";
import {
  generateDraftImage,
  getImageWorkspaceState,
  selectReferencePhotos,
  getDraftImageState,
  attachDraftImage,
  clearDraftBackgrounds,
} from "./content-agent-images.server";
import { getContentAgentPreferencesForWorkspace } from "./content-agent-identity.server";
const draftRefSchema = z
  .object({
    messageId: z.string().uuid(),
    cardId: z.string().min(1).max(100),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const draftImageInputSchema = z
  .object({
    draftRef: draftRefSchema,
    requestKey: z.string().min(1).max(200),
    slideIndex: z.number().int().min(0).max(9).optional(),
  })
  .strict();
export const getContentImageSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return getImageWorkspaceState(context.userId);
  });
export const getContentReferencePhotos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return selectReferencePhotos(context.userId);
  });
export const getContentExistingPhotos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return selectReferencePhotos(context.userId, false);
  });
export const requestDraftImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => draftImageInputSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    const prefs = await getContentAgentPreferencesForWorkspace(context.userId);
    const job = await generateDraftImage({
      userId: context.userId,
      ...data,
      referenceIds: prefs.use_face_references ? prefs.reference_photo_ids || [] : [],
    });
    return { id: String(job.id), status: String(job.status) };
  });
export const getAgentDraftImages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => draftRefSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return getDraftImageState(context.userId, data);
  });
export const attachAgentDraftImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        draftRef: draftRefSchema,
        mediaId: z.string().uuid(),
        slideIndex: z.number().int().min(0).max(9).default(0),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return attachDraftImage(context.userId, data.draftRef, data.mediaId, data.slideIndex);
  });

export const clearAgentDraftBackgrounds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => draftRefSchema.parse(input))
  .handler(async ({ context, data }) => {
    await requireContentWorkspace(context.userId);
    return clearDraftBackgrounds(context.userId, data);
  });
