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
  for (const type of ["avatars", "voices"] as const)
    server.registerTool(
      `list_reel_${type}`,
      {
        title: `List managed Reel ${type}`,
        description: `Read ${type} authorized for this creator's managed Reel production. Use returned IDs only. A shared account never grants access to other creators' private avatars or voices. Creator+ allowance required.`,
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
        "Prepare an exact saved Reel revision for narration, visible-only avatar segments, timed subtitles and a finished MP4. Use get_content_brain, get_content_discover and real workspace media first; save an editable project with voiceId/avatarId and spoken avatarScript on every narrated scene, including B-roll. Prefer short opening/closing avatar appearances and audio-only middle scenes. Include optional publication intent with actual connected account IDs, platform captions, requested timezone and timestamp; the user reviews this in Scheduler after approving the video. Return the cost estimate and reviewPath. This does not approve spending, generate footage or publish. Creator+ only; do not offer a managed fallback to Creator/BYOK.",
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
  server.registerTool(
    "get_reel_production",
    {
      title: "Read a Reel production",
      description:
        "Read the authenticated creator's durable production status, cost estimate and completed Media IDs. Read only: never starts or approves generation or publishing. Benny shows approvals and the private preview inside chat.",
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
        "List the selected workspace's carousel and Reel projects and presets. Pass an entryId to read its saved document, revision, editing plan checks, original brief and owned conversation link. Use these findings when revising; preserve ready avatar/narration IDs for visual-only changes. A technical check is not an aesthetic approval.",
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
        "Save a Carousel or Reel draft or reusable preset to the selected workspace when the user asks to save it. Use revision 0 and a new UUID to create an entry. For edits, get the existing id and revision first. Saving writes the editable project only. Benny presents rendering and downloads inside chat.",
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
        "Revise an existing saved Reel or carousel in chat using its latest copyRevision context. Read get_content_studio_projects first. Preserve sourceSceneId or sourceSlideIndex for retained content, and keep approved narration/duration for visual-only edits. The server retains owned photos, narration and footage when applicable and invalidates obsolete speech. This saves a reviewable revision only; it never generates paid media, renders, schedules or publishes.",
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
        "Read the status and ordered Media IDs of a background export already started in Bento. Use the saved project's entryId, revision and format. This does not start a render or publish anything.",
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
