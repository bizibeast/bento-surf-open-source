import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getInstagramAudioCatalogForUser } from "./instagram-audio.server";
import { instagramAudioCatalogInputSchema } from "./instagram-audio";

export const getInstagramAudioCatalog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => instagramAudioCatalogInputSchema.parse(input))
  .handler(({ context, data }) => getInstagramAudioCatalogForUser(context.userId, data));
