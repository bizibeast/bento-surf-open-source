import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { creatorIntelligenceEnabled, getCreatorIntelligence } from "./creator-intelligence.server";
import { resolveMcpWorkspaceId } from "./mcp-workspace.server";

export async function readCreatorIntelligenceForMcp(
  authUserId: string,
  input: { workspaceId?: string; query?: string },
  resolveWorkspaceId = resolveMcpWorkspaceId,
) {
  const selectedId = await resolveWorkspaceId(authUserId, input.workspaceId ?? authUserId);
  const intelligence = await getCreatorIntelligence({ userId: selectedId, query: input.query });
  if (!intelligence) throw new Error("Creator intelligence is unavailable for this workspace.");
  return { workspaceId: selectedId, intelligence };
}

export function registerCreatorIntelligenceMcpTool(
  server: Pick<McpServer, "registerTool">,
  auth: AuthInfo,
  resolveWorkspaceId = resolveMcpWorkspaceId,
) {
  const userId = auth.extra?.userId;
  if (!creatorIntelligenceEnabled() || typeof userId !== "string") return;

  server.registerTool(
    "get_creator_intelligence",
    {
      title: "Get creator intelligence",
      description:
        "Read the workspace's creator preferences, content topics, confirmed Brain signals, brand settings, and recent stored social metrics for content planning and writing. Available on Creator plans.",
      inputSchema: z
        .object({
          workspaceId: z.string().uuid().optional(),
          query: z.string().trim().min(1).max(1_000).optional(),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, query }) => {
      const data = await readCreatorIntelligenceForMcp(
        userId,
        { workspaceId, query },
        resolveWorkspaceId,
      );
      return {
        structuredContent: data,
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    },
  );
}
