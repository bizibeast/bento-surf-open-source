import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWorkspace = vi.hoisted(() => vi.fn());
vi.mock("./workspace-session.server", () => ({ resolveWorkspace }));

import { listMcpWorkspaces, resolveMcpWorkspaceId } from "./mcp-workspace.server";

const ownerId = "00000000-0000-4000-8000-000000000001";
const brandId = "00000000-0000-4000-8000-000000000002";
const foreignId = "00000000-0000-4000-8000-000000000003";
const workspaces = [
  {
    id: ownerId,
    username: "bizibeast",
    displayName: "Bizibeast",
    status: "active",
    plan: "creator",
  },
  {
    id: brandId,
    username: "bento-surf",
    displayName: "Bento Surf",
    status: "active",
    plan: "creator",
  },
];

describe("MCP workspace selection", () => {
  beforeEach(() => {
    resolveWorkspace.mockReset();
    resolveWorkspace.mockImplementation(async (_authUserId: string, requestedId?: string) => ({
      workspaceId: workspaces.find((workspace) => workspace.id === requestedId)?.id ?? ownerId,
      workspace: workspaces.find((workspace) => workspace.id === requestedId) ?? workspaces[0],
      workspaces,
    }));
  });

  it("lists only memberships returned for the authenticated owner", async () => {
    await expect(listMcpWorkspaces(ownerId)).resolves.toEqual([
      expect.objectContaining({ id: ownerId, username: "bizibeast", isDefault: true }),
      expect.objectContaining({ id: brandId, username: "bento-surf", isDefault: false }),
    ]);
    expect(resolveWorkspace).toHaveBeenCalledWith(ownerId);
  });

  it("keeps old clients on the original workspace and permits an owned active workspace", async () => {
    await expect(resolveMcpWorkspaceId(ownerId)).resolves.toBe(ownerId);
    expect(resolveWorkspace).not.toHaveBeenCalled();
    await expect(resolveMcpWorkspaceId(ownerId, brandId)).resolves.toBe(brandId);
    expect(resolveWorkspace).toHaveBeenCalledWith(ownerId, brandId);
  });

  it("rejects a workspace that is not in the owner's membership list", async () => {
    await expect(resolveMcpWorkspaceId(ownerId, foreignId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("rejects an owned workspace whose access is no longer active", async () => {
    resolveWorkspace.mockResolvedValueOnce({
      workspaceId: brandId,
      workspace: { ...workspaces[1], status: "locked" },
      workspaces: [{ ...workspaces[1], status: "locked" }],
    });
    await expect(resolveMcpWorkspaceId(ownerId, brandId)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
