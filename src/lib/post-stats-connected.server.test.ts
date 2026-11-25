import { describe, expect, it, vi } from "vitest";
vi.mock("./social-publisher.server", () => ({ accessTokenForConnection: vi.fn() }));
import { mergePlatformPostStats, readWorkspacePostStats } from "./post-stats-connected.server";
import type { PublicPostStats, PostStatsEvidence } from "./public-post-stats";
const url = "https://instagram.com/reel/ExactPost";
const workspace = "workspace-one";
const connection = {
  id: "connection",
  user_id: workspace,
  provider: "instagram",
  provider_user_id: "123",
  provider_handle: "creator",
  scopes: ["instagram_business_basic", "instagram_business_manage_insights"],
  status: "active",
  access_token: "encrypted",
  refresh_token: null,
  token_expires_at: null,
  metadata: {},
};
const base: PublicPostStats = {
  platform: "Instagram",
  sourceUrl: url,
  retrievedAt: "2026-11-24T00:00:00.000Z",
  cached: true,
  scope: "public",
  status: "partial",
  metrics: [
    { key: "likes", label: "Likes", value: 9 },
    { key: "saves", label: "Saves", value: null },
  ],
  note: "Public",
};
const evidence: PostStatsEvidence = {
  kind: "platform_api",
  label: "Instagram account analytics",
  observedAt: "2026-11-24T01:00:00.000Z",
  precision: "reported",
  definition: "Owner-reported likes",
  visibility: "workspace",
};
describe("workspace-only post analytics", () => {
  it("keeps public-source pending notices in a workspace-scoped result", () => {
    const result = mergePlatformPostStats(
      { ...base, accessNotes: ["Public collection is pending"] },
      [],
      ["Owner access unavailable"],
    );
    expect(result.accessNotes).toEqual([
      "Public collection is pending",
      "Owner access unavailable",
    ]);
  });
  it("gives official counters precedence without modifying the public cached result", () => {
    const result = mergePlatformPostStats(
      base,
      [{ counts: { likes: 0, saves: 12 }, evidence: { likes: evidence, saves: evidence } }],
      [],
    );
    expect(result).toMatchObject({ scope: "workspace", cached: false, status: "available" });
    expect(result.metrics[0]).toMatchObject({ value: 0, evidence: { visibility: "workspace" } });
    expect(base.metrics[0].value).toBe(9);
    expect(base.metrics[1].value).toBeNull();
    expect(base.scope).toBe("public");
  });
  it("rejects a denied budget before loading tokens, connections or public data", async () => {
    const connections = vi.fn();
    const publicRead = vi.fn();
    const token = vi.fn();
    await expect(
      readWorkspacePostStats(url, workspace, {
        connections,
        publicRead,
        token,
        reserve: vi.fn().mockRejectedValue(new Error("budget denied")),
      }),
    ).rejects.toThrow("budget denied");
    expect(connections).not.toHaveBeenCalled();
    expect(publicRead).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });
  it("does not use a foreign workspace connection even if an adapter returns it", async () => {
    const token = vi.fn();
    const instagram = vi.fn();
    const result = await readWorkspacePostStats(url, workspace, {
      reserve: vi.fn().mockResolvedValue(undefined),
      connections: vi.fn().mockResolvedValue([{ ...connection, user_id: "foreign" }]),
      token,
      instagram,
      publicRead: vi.fn().mockResolvedValue(base),
    });
    expect(token).not.toHaveBeenCalled();
    expect(instagram).not.toHaveBeenCalled();
    expect(result.accessNotes?.join(" ")).toContain("Connect an Instagram");
  });
  it("returns a readiness note for missing scope without decrypting credentials", async () => {
    const token = vi.fn();
    const result = await readWorkspacePostStats(url, workspace, {
      reserve: vi.fn().mockResolvedValue(undefined),
      connections: vi
        .fn()
        .mockResolvedValue([{ ...connection, scopes: ["instagram_business_basic"] }]),
      token,
      publicRead: vi.fn().mockResolvedValue(base),
    });
    expect(token).not.toHaveBeenCalled();
    expect(result.accessNotes?.join(" ")).toContain("permission is missing");
  });
  it("uses only the authorized workspace index and omits another reservation in the public supplement", async () => {
    const index = vi.fn().mockResolvedValue("456");
    const publicRead = vi.fn().mockResolvedValue(base);
    const result = await readWorkspacePostStats(url, workspace, {
      reserve: vi.fn().mockResolvedValue(undefined),
      connections: vi.fn().mockResolvedValue([connection]),
      token: vi.fn().mockResolvedValue("credential"),
      index,
      publicRead,
      instagram: vi.fn().mockResolvedValue({ counts: { likes: 0 }, evidence: { likes: evidence } }),
    });
    expect(index).toHaveBeenCalledWith(workspace, connection.id, url);
    expect(result.metrics[0].value).toBe(0);
    expect(JSON.stringify(result)).not.toContain("credential");
    expect(JSON.stringify(result)).not.toContain("encrypted");
    expect(publicRead.mock.calls[0][1]).toMatchObject({
      trustedMcpWorkspaceId: workspace,
      allowUnavailable: true,
    });
  });
});
