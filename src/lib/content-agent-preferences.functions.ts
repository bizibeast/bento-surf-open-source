/* eslint-disable @typescript-eslint/no-explicit-any -- New preferences table ships with the identity migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireContentWorkspace } from "./content-access.server";
import { SOCIAL_CONNECTION_LIST_LIMIT } from "./large-table-columns";
import { agentBrandingSchema } from "./content-agent-branding";
import {
  getOrCreateNamedAgentThreadForWorkspace,
  getContentAgentPreferencesForWorkspace,
  type ContentAgentIdentity,
} from "./content-agent-identity.server";

export const contentAgentPreferencesInputSchema = z.object({
  branding: agentBrandingSchema.optional(),
  destinationAccounts: z
    .object({
      twitter: z.string().uuid().optional(),
      linkedin: z.string().uuid().optional(),
      instagram: z.string().uuid().optional(),
    })
    .optional(),
  displayName: z
    .string()
    .refine(
      (name) =>
        Array.from(name).every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "Choose a name without control characters.",
    )
    .trim()
    .min(1)
    .max(80)
    .optional(),
  proactivePaused: z.boolean().optional(),
  generateImages: z.boolean().optional(),
  useFaceReferences: z.boolean().optional(),
  referencePhotoIds: z.array(z.string().uuid()).max(4).optional(),
  referencesConfirmed: z.boolean().optional(),
  platforms: z
    .array(z.enum(["twitter", "linkedin", "instagram"]))
    .max(3)
    .transform((values) => [...new Set(values)])
    .optional(),
});
export type ContentAgentPreferencesInput = z.infer<typeof contentAgentPreferencesInputSchema>;

export const getOrCreateNamedAgentThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return getOrCreateNamedAgentThreadForWorkspace(context.userId);
  });
export const getContentAgentPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireContentWorkspace(context.userId);
    return getContentAgentPreferencesForWorkspace(context.userId);
  });
export const updateContentAgentPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => contentAgentPreferencesInputSchema.parse(input))
  .handler(async ({ context, data }): Promise<ContentAgentIdentity> => {
    await requireContentWorkspace(context.userId);
    if (data.branding?.heroPhotoId) {
      const { resolveOwnedAgentMedia } = await import("./content-agent-media.server");
      await resolveOwnedAgentMedia(context.userId, [data.branding.heroPhotoId]);
    }
    if (
      data.generateImages === true ||
      data.useFaceReferences === true ||
      data.referencePhotoIds !== undefined
    ) {
      const { imageProviderAvailable, validateReferenceSelection } =
        await import("./content-agent-images.server");
      if (data.generateImages === true || data.useFaceReferences === true) {
        const current = await getContentAgentPreferencesForWorkspace(context.userId);
        if (
          ((!current.generate_images && data.generateImages === true) ||
            (!current.use_face_references && data.useFaceReferences === true)) &&
          !imageProviderAvailable(context.userId)
        )
          throw new Error("Image generation is not available for this workspace yet.");
        if (data.useFaceReferences === true && data.referencePhotoIds === undefined)
          await validateReferenceSelection(context.userId, current.reference_photo_ids || [], true);
      }
      if (data.referencePhotoIds !== undefined) {
        const current = await getContentAgentPreferencesForWorkspace(context.userId);
        const added = data.referencePhotoIds.filter(
          (id) => !current.reference_photo_ids?.includes(id),
        );
        // Removing/repeating saved IDs while revoking consent never depends on R2 availability.
        if (added.length || data.useFaceReferences === true)
          await validateReferenceSelection(
            context.userId,
            data.useFaceReferences === true ? data.referencePhotoIds : added,
            Boolean(data.referencesConfirmed) || added.length === 0,
          );
      }
    }
    const patch = {
      ...(data.branding ? { branding: data.branding } : {}),
      ...(data.destinationAccounts ? { destination_accounts: data.destinationAccounts } : {}),
      ...(data.referencePhotoIds !== undefined
        ? {
            reference_photo_ids: data.referencePhotoIds,
            references_confirmed: Boolean(data.referencesConfirmed),
          }
        : {}),
      ...(data.displayName !== undefined ? { display_name: data.displayName } : {}),
      ...(data.proactivePaused !== undefined ? { proactive_paused: data.proactivePaused } : {}),
      ...(data.generateImages !== undefined ? { generate_images: data.generateImages } : {}),
      ...(data.useFaceReferences !== undefined
        ? { use_face_references: data.useFaceReferences }
        : {}),
      ...(data.platforms !== undefined ? { platforms: data.platforms } : {}),
    };
    const { data: saved, error } = await (supabaseAdmin as any).rpc(
      "update_content_agent_preferences",
      { p_user_id: context.userId, p_patch: patch },
    );
    if (error || !saved) throw new Error("Agent preferences could not be saved.");
    return saved;
  });

export const getContentPublishingAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<
      Array<{
        id: string;
        provider: "twitter" | "linkedin" | "instagram";
        provider_handle: string | null;
      }>
    > => {
      await requireContentWorkspace(context.userId);
      const { data, error } = await (supabaseAdmin as any)
        .from("social_connections")
        .select("id,provider,provider_handle")
        .eq("user_id", context.userId)
        .eq("status", "active")
        .eq("reauth_required", false)
        .in("provider", ["twitter", "linkedin", "instagram"])
        .order("created_at", { ascending: false })
        .limit(SOCIAL_CONNECTION_LIST_LIMIT);
      if (error) throw new Error("Your connected accounts could not be loaded.");
      return data || [];
    },
  );
