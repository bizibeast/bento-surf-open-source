import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  isContentReferenceEnabled,
  listContentReferences,
  queueContentReference,
  readContentReference,
} from "./content-reference-jobs.server";
import { referenceSourceUrl } from "./content-reference";
import { enforceRequestRateLimit } from "./request-security.server";
import { z } from "zod";

export const getContentReferenceCapability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(() => isContentReferenceEnabled());

export const getContentReferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    listContentReferences({ workspaceId: context.workspaceId, authUserId: context.authUserId }),
  );

export const getContentReference = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.uuid() }).strict().parse(input))
  .handler(async ({ context, data }) =>
    readContentReference(
      { workspaceId: context.workspaceId, authUserId: context.authUserId },
      data.id,
    ),
  );

export const startContentReference = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        requestId: z.uuid(),
        sourceUrl: referenceSourceUrl,
        gridOnly: z.boolean().default(false),
        rightsConfirmed: z.literal(true),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "content-reference",
      context.workspaceId,
    );
    return queueContentReference(
      { workspaceId: context.workspaceId, authUserId: context.authUserId },
      {
        workspaceId: context.workspaceId,
        requestId: data.requestId,
        rightsConfirmed: data.rightsConfirmed,
        sourceUrl: data.sourceUrl,
        mode: data.gridOnly ? "all" : "overview",
      },
      data.gridOnly,
    );
  });
