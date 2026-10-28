import { RequestHttpError } from "./request-security.server";
import { resolveWorkspace } from "./workspace-session.server";

/** MCP has no browser workspace cookie, so destinations must be explicit. */
export async function listMcpWorkspaces(authUserId: string) {
  const session = await resolveWorkspace(authUserId);
  return session.workspaces.map((workspace) => ({
    id: workspace.id,
    username: workspace.username,
    displayName: workspace.displayName,
    status: workspace.status,
    plan: workspace.plan,
    isDefault: workspace.id === authUserId,
  }));
}

export async function resolveMcpWorkspaceId(authUserId: string, requestedId?: string) {
  // Keep existing MCP clients on the original workspace when they omit this field.
  if (!requestedId) return authUserId;

  const session = await resolveWorkspace(authUserId, requestedId);
  if (session.workspaceId !== requestedId || session.workspace.status !== "active") {
    throw new RequestHttpError(403, "Workspace is unavailable.");
  }
  return requestedId;
}
