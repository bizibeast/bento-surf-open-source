import { z } from "zod";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

const contentTabSchema = z.object({ tab: z.enum(["discover", "agent", "brain"]) }).strict();

export function createContentTabWebMcpTool(
  openTab: (tab: "discover" | "agent" | "brain") => void | Promise<void>,
): WebMcpTool {
  return {
    name: "open_content_tab",
    title: "Open a Content workspace tab",
    description: "Opens the visible Discover, Agent, or Brain tab in this workspace.",
    inputSchema: {
      type: "object",
      properties: { tab: { type: "string", enum: ["discover", "agent", "brain"] } },
      required: ["tab"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input, { signal }) {
      const { tab } = contentTabSchema.parse(input);
      signal.throwIfAborted();
      await requireWebMcpUserConfirmation("Open this Content tab", { tab });
      signal.throwIfAborted();
      await openTab(tab);
      signal.throwIfAborted();
      return webMcpResult(`Opened the ${tab} tab.`, { path: `/content?tab=${tab}` });
    },
  };
}
