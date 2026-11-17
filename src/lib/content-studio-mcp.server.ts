import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { studioSaveInputSchema } from "./content-studio";
import {
  listContentStudioEntriesForWorkspace,
  saveContentStudioEntryForWorkspace,
} from "./content-studio.server";
import { resolveMcpWorkspaceId } from "./mcp-workspace.server";
import { studioCarouselJobInput } from "./studio-carousel-job";
import { studioCarouselJobStatus } from "./studio-carousel-jobs.server";

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
) {
  const userId = auth.extra?.userId;
  if (
    process.env.BENTO_V2_STUDIO_ENABLED !== "true" ||
    typeof userId !== "string" ||
    !auth.clientId ||
    !auth.scopes.includes("openid")
  )
    return;

  server.registerTool(
    "get_content_studio_projects",
    {
      title: "Read Content Studio projects",
      description:
        "List the selected workspace's carousel and Reel projects and presets. Pass an entryId to read the saved document and revision for a specific project.",
      inputSchema: z.object({ workspaceId: z.uuid(), entryId: z.uuid().optional() }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, entryId }) => {
      const entries = await listContentStudioEntriesForWorkspace(
        await resolveWorkspaceId(userId, workspaceId),
      );
      if (entryId) {
        const entry = entries.find((candidate) => candidate.id === entryId);
        if (!entry) throw new Error("Content Studio project is unavailable.");
        return result({ entry });
      }
      return result({
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
      title: "Save a Content Studio project",
      description:
        "Save a Carousel or Reel draft or reusable preset to the selected workspace when the user asks to save it. Use revision 0 and a new UUID to create an entry. For edits, get the existing id and revision first. Saving writes the editable project only. Render and download in Bento.",
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
    "get_content_studio_render",
    {
      title: "Read Content Studio export status",
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
