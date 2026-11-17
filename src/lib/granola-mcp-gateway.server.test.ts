import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = {
    update: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
  };
  return { query, listResources: vi.fn(), loadConnection: vi.fn() };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => mocks.query },
}));
vi.mock("./content-connections.server", () => ({
  loadContentConnectionForUser: mocks.loadConnection,
}));
vi.mock("./content-access.server", () => ({ requireContentWorkspace: vi.fn() }));
vi.mock("./external-tools.server", () => ({ externalToolsEnabled: () => true }));
vi.mock("./granola-content.server", () => ({
  createGranolaAdapter: () => ({ listResources: mocks.listResources }),
  granolaReady: () => true,
}));
vi.mock("./request-security.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-security.server")>()),
  enforceRequestRateLimit: vi.fn(),
}));

import {
  listGranolaGatewayFolders,
  setGranolaGatewayPermission,
} from "./granola-mcp-gateway.server";

const workspace = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000002";
const grant = {
  id: connectionId,
  display_name: "Granola",
  selected_resources: { ids: ["a", "b"] },
  mcp_folders_enabled: true,
};

describe("Granola OAuth delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.maybeSingle.mockReset();
    mocks.loadConnection.mockResolvedValue({ provider: "granola" });
    mocks.listResources.mockResolvedValue([
      { id: "a", name: "Selected one", type: "folder" },
      { id: "b", name: "Selected two", type: "folder" },
      { id: "c", name: "Unselected", type: "folder" },
      { id: "all", name: "User account", type: "workspace" },
    ]);
  });

  it("shares only selected folder names and checks consent again after the upstream call", async () => {
    mocks.query.maybeSingle
      .mockResolvedValueOnce({ data: grant, error: null })
      .mockResolvedValueOnce({
        data: { ...grant, selected_resources: { ids: ["a", "c"] } },
        error: null,
      });
    await expect(listGranolaGatewayFolders(workspace, workspace, connectionId)).resolves.toEqual({
      folders: [{ id: "a", name: "Selected one" }],
    });
    expect(mocks.query.eq).toHaveBeenCalledWith("mcp_folders_enabled", true);
    expect(mocks.query.or).toHaveBeenCalledOnce();
  });

  it("denies other actors and denies disclosure when the owner revokes access during a call", async () => {
    await expect(
      listGranolaGatewayFolders(workspace, connectionId, connectionId),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.listResources).not.toHaveBeenCalled();
    mocks.query.maybeSingle
      .mockResolvedValueOnce({ data: grant, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(
      listGranolaGatewayFolders(workspace, workspace, connectionId),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("cannot turn the default all-folders selection into permission", async () => {
    mocks.query.maybeSingle.mockResolvedValueOnce({
      data: { ...grant, selected_resources: { ids: ["all"] } },
      error: null,
    });
    await expect(
      setGranolaGatewayPermission(workspace, workspace, connectionId, true),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.query.update).not.toHaveBeenCalled();
  });
});
