import { afterEach, describe, expect, it, vi } from "vitest";
import { registerContentReferenceMcpTools } from "./content-reference-mcp.server";
const mocks = vi.hoisted(() => ({ queue: vi.fn(), read: vi.fn(), list: vi.fn(), create: vi.fn() }));
vi.mock("./content-reference-jobs.server", () => ({
  queueContentReference: mocks.queue,
  readContentReference: mocks.read,
  listContentReferences: mocks.list,
}));
vi.mock("./content-reference-draft.server", () => ({ createReferenceDraft: mocks.create }));
const workspaceId = "11111111-1111-4111-8111-111111111111";
const authUserId = "22222222-2222-4222-8222-222222222222";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("Benny and external reference tool registry", () => {
  it("does not advertise disabled reference tools", () => {
    vi.stubEnv("BENTO_V2_REFERENCE_ANALYSIS_ENABLED", "false");
    const registerTool = vi.fn();
    registerContentReferenceMcpTools({ registerTool }, vi.fn());
    expect(registerTool).not.toHaveBeenCalled();
  });
  it("authenticates each requested workspace, distinguishes analysis writes from status reads, and defaults grids to every frame", async () => {
    vi.stubEnv("BENTO_V2_REFERENCE_ANALYSIS_ENABLED", "true");
    const registerTool = vi.fn();
    const actor = vi.fn().mockResolvedValue({ workspaceId, authUserId });
    registerContentReferenceMcpTools({ registerTool }, actor);
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      "analyze_content_reference",
      "create_video_frame_grid",
      "get_content_reference",
      "create_content_from_reference",
    ]);
    const grid = registerTool.mock.calls.find(([name]) => name === "create_video_frame_grid")!;
    const input = grid[1].inputSchema.parse({
      workspaceId,
      requestId: authUserId,
      mediaId: authUserId,
      rightsConfirmed: true,
    });
    mocks.queue.mockResolvedValue({ id: authUserId, status: "queued" });
    const acknowledgment = await grid[2](input);
    expect(acknowledgment.content[0].text).toContain(`Frame grid ${authUserId} is queued`);
    expect(input.mode).toBe("all");
    expect(grid[1].annotations.readOnlyHint).toBe(false);
    expect(actor).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(mocks.queue).toHaveBeenCalledExactlyOnceWith({ workspaceId, authUserId }, input, true);
    const analyze = registerTool.mock.calls.find(([name]) => name === "analyze_content_reference")!;
    expect((await analyze[2](input)).content[0].text).toContain(
      `Reference ${authUserId} is queued`,
    );
    const create = registerTool.mock.calls.find(
      ([name]) => name === "create_content_from_reference",
    )!;
    mocks.create.mockResolvedValue({
      entry: { id: authUserId, revision: 7, title: "Duplicate title", kind: "project" },
      warnings: [],
      reviewPath: "/content?tab=studio",
    });
    const receipt = (await create[2]({ workspaceId })).content[0].text;
    expect(receipt).toContain(authUserId);
    expect(receipt).toContain("revision 7");
    expect(receipt).toContain("/content?tab=studio");
    const read = registerTool.mock.calls.find(([name]) => name === "get_content_reference")!;
    expect(read[1].annotations.readOnlyHint).toBe(true);
    actor.mockRejectedValueOnce(new Error("Foreign workspace"));
    await expect(read[2]({ workspaceId, jobId: authUserId })).rejects.toThrow("Foreign workspace");
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
