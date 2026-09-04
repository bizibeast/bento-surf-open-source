import { describe, expect, it, vi } from "vitest";

const { submitReachReward } = vi.hoisted(() => ({ submitReachReward: vi.fn() }));
vi.mock("./referral.functions", () => ({ submitReachReward }));

import { createEarnReachWebMcpTool } from "./webmcp-earn";

describe("Earn WebMCP tool", () => {
  it("fails closed on denial and refreshes after one approved submission", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const tool = createEarnReachWebMcpTool(refresh);
    const input = { postUrl: "https://www.linkedin.com/posts/example" };
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(tool.execute(input, { signal: new AbortController().signal })).rejects.toThrow(
      "did not approve",
    );
    expect(submitReachReward).not.toHaveBeenCalled();

    submitReachReward.mockResolvedValue({ id: "submission-id", status: "verifying" });
    await expect(
      tool.execute(input, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      structuredContent: { submission: { id: "submission-id", status: "verifying" } },
    });
    expect(submitReachReward).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
