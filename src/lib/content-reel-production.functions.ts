import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { reelProductionInput, reelProductionIdInput } from "./content-reel-production";
import {
  prepareReelProduction,
  approveReelProduction,
  cancelReelProduction,
  latestReelProduction,
  readReelProduction,
} from "./content-reel-production.server";
import { getReelProductionPreview, approveReelForScheduler } from "./content-reel-preview.server";

function actor(
  context: { workspaceId: string; authUserId: string; claims: object },
  requested: string,
) {
  if (requested !== context.workspaceId || "client_id" in context.claims)
    throw new Error("Use the selected workspace in the signed-in Bento app.");
  return {
    workspaceId: context.workspaceId,
    authUserId: context.authUserId,
    clientId: "bento-browser",
  };
}
export const prepareStudioReelProduction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reelProductionInput.parse(input))
  .handler(({ context, data }) => prepareReelProduction(actor(context, data.workspaceId), data));
export const approveStudioReelProduction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reelProductionIdInput.parse(input))
  .handler(({ context, data }) =>
    approveReelProduction(actor(context, data.workspaceId), data.productionId),
  );
export const cancelStudioReelProduction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reelProductionIdInput.parse(input))
  .handler(({ context, data }) =>
    cancelReelProduction(actor(context, data.workspaceId), data.productionId),
  );
export const getStudioReelProduction = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reelProductionIdInput.parse(input))
  .handler(({ context, data }) =>
    readReelProduction(actor(context, data.workspaceId), data.productionId),
  );
export const previewStudioReelProduction = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reelProductionIdInput.parse(input))
  .handler(({ context, data }) =>
    getReelProductionPreview(actor(context, data.workspaceId), data.productionId),
  );
export const approveStudioReelForScheduler = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => reelProductionIdInput.parse(input))
  .handler(({ context, data }) =>
    approveReelForScheduler(actor(context, data.workspaceId), data.productionId),
  );
export const getLatestStudioReelProduction = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ workspaceId: z.uuid(), entryId: z.uuid() }).strict().parse(input),
  )
  .handler(({ context, data }) =>
    latestReelProduction(actor(context, data.workspaceId), data.entryId),
  );
