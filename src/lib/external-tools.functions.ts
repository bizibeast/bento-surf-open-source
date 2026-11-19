import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  externalCredentialSchema,
  externalProviderSchema,
  heyGenCatalogInput,
  heyGenGenerationInput,
  heyGenJobInput,
} from "./external-tools";
import {
  approveHeyGenJob,
  connectExternalTool,
  disconnectExternalTool,
  getExternalConnections,
  listHeyGenAvatarsFor,
  listHeyGenVoicesFor,
  pollHeyGenJob,
  prepareHeyGenJob,
  readHeyGenJob,
  startHeyGenJob,
} from "./external-tools.server";
import { RequestHttpError } from "./request-security.server";

function browserActor(context: {
  claims: object;
  workspaceId: string;
  authUserId: string;
  workspaceSession: { workspace: { status: string } };
}) {
  if ("client_id" in context.claims)
    throw new RequestHttpError(403, "Use the signed-in Bento app.");
  if (context.workspaceSession.workspace.status !== "active") {
    throw new RequestHttpError(403, "Workspace is unavailable.");
  }
  return {
    workspaceId: context.workspaceId,
    authUserId: context.authUserId,
    clientId: "bento-browser",
  };
}

export const getExternalToolConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => getExternalConnections(browserActor(context)));

export const saveExternalToolConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(externalCredentialSchema)
  .handler(async ({ context, data }) => connectExternalTool(browserActor(context), data));

export const removeExternalToolConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ provider: externalProviderSchema }).strict())
  .handler(async ({ context, data }) =>
    disconnectExternalTool(browserActor(context), data.provider),
  );

export const listHeyGenAvatars = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(heyGenCatalogInput)
  .handler(async ({ context, data }) => listHeyGenAvatarsFor(browserActor(context), data));

export const listHeyGenVoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(heyGenCatalogInput)
  .handler(async ({ context, data }) => listHeyGenVoicesFor(browserActor(context), data));

export const prepareHeyGenGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(heyGenGenerationInput)
  .handler(async ({ context, data }) => prepareHeyGenJob(browserActor(context), data));

export const reviewHeyGenGeneration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(heyGenJobInput)
  .handler(async ({ context, data }) => readHeyGenJob(browserActor(context), data.jobId));

export const approveHeyGenGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(heyGenJobInput)
  .handler(async ({ context, data }) => approveHeyGenJob(browserActor(context), data.jobId));

export const startHeyGenGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(heyGenJobInput)
  .handler(async ({ context, data }) => startHeyGenJob(browserActor(context), data.jobId));

export const getHeyGenGeneration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(heyGenJobInput)
  .handler(async ({ context, data }) => pollHeyGenJob(browserActor(context), data.jobId));
