import { describe, expect, it, vi } from "vitest";
vi.unmock("./provider-budget.server");
const rpc = vi.hoisted(() => vi.fn().mockResolvedValue({ data: true, error: null }));
vi.mock("./public-post-stats.server", () => ({
  handlePublicPostStatsRequest: async () => {
    const { reserveProviderUsage } = await import("./provider-budget.server");
    await Promise.resolve();
    await reserveProviderUsage("browser_milliseconds", 30000, { client: { rpc } });
    return Response.json({ metrics: [] });
  },
}));
import { getMcpPublicPostStats } from "./mcp-free-tools.server";
import { reserveProviderUsage } from "./provider-budget.server";
describe("MCP public stats browser accounting", () => {
  it("isolates concurrent workspace reservations and restores global scope afterward", async () => {
    await Promise.all([
      getMcpPublicPostStats("workspace-a", { url: "https://instagram.com/reel/one" }),
      getMcpPublicPostStats("workspace-b", { url: "https://instagram.com/reel/two" }),
    ]);
    const scopes = rpc.mock.calls.map((call) => call[1].p_workspace_id).sort();
    expect(scopes).toEqual(["workspace-a", "workspace-b"]);
    await reserveProviderUsage("browser_milliseconds", 1, { client: { rpc } });
    expect(rpc.mock.lastCall?.[1].p_workspace_id).toBeNull();
  });
});
