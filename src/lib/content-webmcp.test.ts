// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createContentTabWebMcpTool } from "./content-webmcp";

it("opens only a validated Content tab after browser approval", async () => {
  const openTab = vi.fn();
  const tool = createContentTabWebMcpTool(openTab);
  const signal = new AbortController().signal;
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

  expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: ["tab"] });
  await expect(tool.execute({ tab: "unknown" }, { signal })).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled();
  await expect(tool.execute({ tab: "agent" }, { signal })).rejects.toThrow("did not approve");
  expect(openTab).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  await expect(tool.execute({ tab: "brain" }, { signal })).resolves.toMatchObject({
    structuredContent: { path: "/content?tab=brain" },
  });
  expect(openTab).toHaveBeenCalledWith("brain");
});
