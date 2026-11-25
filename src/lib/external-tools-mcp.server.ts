import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { githubPullRequestSchema } from "./external-tools";
import {
  externalToolsEnabled,
  getExternalConnections,
  readGithubAccount,
  readGithubPullRequest,
} from "./external-tools.server";
import { resolveMcpWorkspaceId } from "./mcp-workspace.server";
import {
  granolaGatewayEnabled,
  listGranolaGatewayConnections,
  listGranolaGatewayFolders,
} from "./granola-mcp-gateway.server";

const workspace = z.object({ workspaceId: z.uuid() }).strict();
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
function result(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function registerExternalMcpTools(
  server: Pick<McpServer, "registerTool">,
  auth: AuthInfo,
  resolveWorkspaceId = resolveMcpWorkspaceId,
) {
  const authUserId = auth.extra?.userId;
  if (
    !externalToolsEnabled() ||
    typeof authUserId !== "string" ||
    !auth.clientId ||
    auth.clientId === "bento-browser" ||
    !auth.scopes.includes("openid")
  )
    return;

  async function actor(workspaceId: string) {
    return {
      workspaceId: await resolveWorkspaceId(authUserId as string, workspaceId),
      authUserId: authUserId as string,
      clientId: auth.clientId,
    };
  }

  server.registerTool(
    "list_external_tool_connections",
    {
      title: "List external connections",
      description:
        "List your own connected providers and supported capabilities in the selected Bento workspace.",
      inputSchema: workspace,
      annotations: { ...readOnly, openWorldHint: false },
    },
    async ({ workspaceId }) => result(await getExternalConnections(await actor(workspaceId))),
  );

  server.registerTool(
    "get_github_mcp_account",
    {
      title: "Read connected GitHub account",
      description:
        "Check the account behind your read-only GitHub MCP connection in this workspace. Returns the GitHub login.",
      inputSchema: workspace,
      annotations: readOnly,
    },
    async ({ workspaceId }) => result(await readGithubAccount(await actor(workspaceId))),
  );

  server.registerTool(
    "get_github_mcp_pull_request",
    {
      title: "Read approved GitHub pull request",
      description:
        "Read the title, state and URL of one pull request from the repository approved in Bento MCP settings.",
      inputSchema: workspace.extend(githubPullRequestSchema.shape),
      annotations: readOnly,
    },
    async ({ workspaceId, ...input }) =>
      result(await readGithubPullRequest(await actor(workspaceId), input)),
  );

  if (granolaGatewayEnabled()) {
    server.registerTool(
      "list_granola_mcp_connections",
      {
        title: "List Granola OAuth connections",
        description:
          "Lists your Granola OAuth connections and folder delegation status in your personal Bento workspace.",
        inputSchema: workspace,
        annotations: { ...readOnly, openWorldHint: false },
      },
      async ({ workspaceId }) => {
        const scoped = await actor(workspaceId);
        return result(await listGranolaGatewayConnections(scoped.workspaceId, scoped.authUserId));
      },
    );
    server.registerTool(
      "list_granola_mcp_folders",
      {
        title: "List approved Granola folder names",
        description:
          "Uses your Granola OAuth connection to read names and IDs of folders you selected in Bento. Requires explicit folder delegation in Bento MCP settings.",
        inputSchema: workspace.extend({ connectionId: z.uuid() }),
        annotations: readOnly,
      },
      async ({ workspaceId, connectionId }) => {
        const scoped = await actor(workspaceId);
        return result(
          await listGranolaGatewayFolders(scoped.workspaceId, scoped.authUserId, connectionId),
        );
      },
    );
  }
}
