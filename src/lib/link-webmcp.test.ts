// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createLinkSocialInsightsWebMcpTools } from "./link-webmcp";

describe("Link social Insights WebMCP tools", () => {
  it("reads visibility and requires approval before changing it", async () => {
    const setEnabled = vi.fn().mockResolvedValue({
      enabled: true,
      publicUrl: "https://bento.surf/creator/insights",
    });
    const tools = createLinkSocialInsightsWebMcpTools({
      enabled: false,
      publicPath: "/creator/insights",
      setEnabled,
    });
    const read = tools.find((tool) => tool.name === "bento_get_social_insights_visibility")!;
    const write = tools.find((tool) => tool.name === "bento_set_social_insights_visibility")!;
    const signal = new AbortController().signal;

    expect(read.execute({}, { signal })).toMatchObject({
      structuredContent: { enabled: false, publicPath: null },
    });

    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await expect(write.execute({ enabled: true }, { signal })).rejects.toThrow("did not approve");
    expect(setEnabled).not.toHaveBeenCalled();

    await expect(write.execute({ enabled: true }, { signal })).resolves.toMatchObject({
      structuredContent: {
        enabled: true,
        publicUrl: "https://bento.surf/creator/insights",
      },
    });
    expect(setEnabled).toHaveBeenCalledWith(true);
  });
});
