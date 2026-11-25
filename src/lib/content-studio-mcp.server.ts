import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { studioSaveInputSchema } from "./content-studio";
import {
  listContentStudioEntriesForWorkspace,
  saveContentStudioEntryForWorkspace,
  getStudioWorkspaceBrand,
} from "./content-studio.server";
import { resolveMcpWorkspaceId } from "./mcp-workspace.server";
import { studioCarouselJobInput } from "./studio-carousel-job";
import { studioCarouselJobStatus } from "./studio-carousel-jobs.server";
import { reelProductionInput, reelProductionIdInput } from "./content-reel-production";
import { prepareReelProduction, readReelProduction } from "./content-reel-production.server";
import { heyGenCatalogInput } from "./external-tools";
import { listHeyGenAvatarsFor, listHeyGenVoicesFor } from "./external-tools.server";
import { registerContentReferenceMcpTools } from "./content-reference-mcp.server";
import { reviewContentCreation } from "./content-creation-harness";
import {
  applyGeneratedStudioDraft,
  generatedStudioDraftSchema,
  studioDraftContext,
} from "./content-studio-generation";

function result(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function registerContentStudioMcpTools(
  server: Pick<McpServer, "registerTool">,
  auth: AuthInfo,
  resolveWorkspaceId = resolveMcpWorkspaceId,
  nativeAuthUserId?: () => Promise<string>,
  includeReelProduction = true,
) {
  const userId = auth.extra?.userId;
  if (
    process.env.BENTO_V2_STUDIO_ENABLED !== "true" ||
    typeof userId !== "string" ||
    !auth.clientId ||
    !auth.scopes.includes("openid")
  )
    return;

  const actor = async (workspaceId: string) => {
    const authUserId = nativeAuthUserId ? await nativeAuthUserId() : userId;
    return {
      workspaceId: await resolveWorkspaceId(authUserId, workspaceId),
      authUserId,
      clientId: "bento-browser",
    };
  };
  registerContentReferenceMcpTools(server, actor);
  if (includeReelProduction) {
    for (const type of ["avatars", "voices"] as const)
      server.registerTool(
        `list_reel_${type}`,
        {
          title: `List managed Reel ${type}`,
          description: `List ${type} authorized for the creator's managed Reel production. Requires a Creator+ allowance.`,
          inputSchema: heyGenCatalogInput
            .omit({ billing: true })
            .extend({ workspaceId: z.uuid() })
            .strict(),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        async ({ workspaceId, ...input }) =>
          result(
            await (type === "avatars" ? listHeyGenAvatarsFor : listHeyGenVoicesFor)(
              await actor(workspaceId),
              { ...input, billing: "managed" },
            ),
          ),
      );
    server.registerTool(
      "prepare_reel_production",
      {
        title: "Prepare a managed Reel production",
        description:
          "Prepare a saved Reel revision for managed narration, avatar segments, subtitles and video production. Returns a cost estimate and review path. Requires Creator+.",
        inputSchema: reelProductionInput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) =>
        result({ production: await prepareReelProduction(await actor(input.workspaceId), input) }),
    );
  }
  server.registerTool(
    "get_reel_production",
    {
      title: "Read a Reel production",
      description:
        "Read the creator’s Reel production status, cost estimate and completed Media IDs.",
      inputSchema: reelProductionIdInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      result({
        production: await readReelProduction(await actor(input.workspaceId), input.productionId),
      }),
  );

  server.registerTool(
    "get_content_studio_projects",
    {
      title: "Read saved content",
      description:
        "List the selected workspace's carousel and Reel projects and presets, or read a saved document and revision by entry ID.",
      inputSchema: z.object({ workspaceId: z.uuid(), entryId: z.uuid().optional() }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, entryId }) => {
      const resolved = await resolveWorkspaceId(userId, workspaceId);
      const [entries, brand] = await Promise.all([
        listContentStudioEntriesForWorkspace(resolved),
        getStudioWorkspaceBrand(resolved),
      ]);
      if (entryId) {
        const entry = entries.find((candidate) => candidate.id === entryId);
        if (!entry) throw new Error("Content Saved content is unavailable.");
        const { loadContentCreationHistory } = await import("./content-creation-history.server");
        return result({
          entry,
          brand,
          editingReview: reviewContentCreation(entry.document),
          copyRevision: studioDraftContext(entry.document),
          history: await loadContentCreationHistory(resolved, entry.id),
        });
      }
      return result({
        brand,
        entries: entries.map(({ id, kind, title, revision, document }) => ({
          id,
          kind,
          title,
          revision,
          format: document.format,
        })),
      });
    },
  );

  server.registerTool(
    "save_content_studio_project",
    {
      title: "Save content",
      description:
        "Save a Carousel or Reel draft or reusable preset to the selected workspace. New entries have revision 0; edits identify an existing entry and revision. Saving writes the editable project only and does not render it.",
      inputSchema: studioSaveInputSchema.strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, ...entry }) =>
      result({
        entry: await saveContentStudioEntryForWorkspace(
          await resolveWorkspaceId(userId, workspaceId),
          entry,
        ),
      }),
  );

  server.registerTool(
    "revise_content_studio_copy",
    {
      title: "Revise saved content",
      description:
        "Revise and save the copy of an existing Reel or carousel, retaining applicable owned media and invalidating obsolete speech.",
      inputSchema: z
        .object({
          workspaceId: z.uuid(),
          entryId: z.uuid(),
          revision: z.number().int().positive(),
          draft: generatedStudioDraftSchema,
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, entryId, revision, draft }) => {
      const resolved = await resolveWorkspaceId(userId, workspaceId);
      const entry = (await listContentStudioEntriesForWorkspace(resolved)).find(
        (item) => item.id === entryId,
      );
      if (!entry) throw new Error("Saved content is unavailable.");
      if (entry.revision !== revision)
        throw new Error("This item changed in another session. Read the latest revision first.");
      const updated = applyGeneratedStudioDraft(entry.document, draft);
      const saved = await saveContentStudioEntryForWorkspace(resolved, { ...entry, ...updated });
      return result({ entry: saved, editingReview: reviewContentCreation(saved.document) });
    },
  );

  server.registerTool(
    "get_content_studio_render",
    {
      title: "Read content export status",
      description:
        "Read the status and ordered Media IDs of a background export started in Bento by project entry ID, revision, and format. This does not start a render or publish anything.",
      inputSchema: studioCarouselJobInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, ...entry }) => {
      const status = await studioCarouselJobStatus(
        { ...entry, workspaceId: await resolveWorkspaceId(userId, workspaceId) },
        userId,
      );
      return result({ available: status.available, job: status.job });
    },
  );
}
