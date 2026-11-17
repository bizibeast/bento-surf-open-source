import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { hasPlanEntitlement } from "./plan.server";

export const getContentStudioAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    if (process.env.BENTO_V2_STUDIO_ENABLED !== "true") return null;
    return (await hasPlanEntitlement(context.workspaceId, "discover")) ? context.workspaceId : null;
  });
