import { z } from "zod";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "./webmcp";

export function createLinkSocialInsightsWebMcpTools({
  enabled,
  publicPath,
  setEnabled,
}: {
  enabled: boolean;
  publicPath: string | null;
  setEnabled: (enabled: boolean) => Promise<{ enabled: boolean; publicUrl: string | null }>;
}): WebMcpTool[] {
  return [
    {
      name: "bento_get_social_insights_visibility",
      title: "Get public Insights visibility",
      description:
        "Returns whether the signed-in creator's public social Insights page is enabled.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute(input) {
        z.object({}).strict().parse(input);
        return webMcpResult("Loaded public Insights visibility.", {
          enabled,
          publicPath: enabled ? publicPath : null,
        });
      },
    },
    {
      name: "bento_set_social_insights_visibility",
      title: "Set public Insights visibility",
      description:
        "Enables or disables the signed-in creator's public social Insights page after browser approval.",
      inputSchema: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async (input, { signal }) => {
        const parsed = z.object({ enabled: z.boolean() }).strict().parse(input);
        signal.throwIfAborted();
        await requireWebMcpUserConfirmation("Set public Insights visibility", parsed);
        signal.throwIfAborted();
        const result = await setEnabled(parsed.enabled);
        signal.throwIfAborted();
        return webMcpResult(
          result.enabled
            ? "Enabled the public Insights page."
            : "Disabled the public Insights page.",
          { enabled: result.enabled, publicUrl: result.enabled ? result.publicUrl : null },
        );
      },
    },
  ];
}
