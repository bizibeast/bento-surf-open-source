import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { z } from "zod";

const McpSetupPage = lazy(() =>
  import("./-mcp-setup-page").then((module) => ({ default: module.McpSetupPage })),
);
const ExternalToolSettings = lazy(() =>
  import("@/components/settings/ExternalToolSettings").then((module) => ({
    default: module.ExternalToolSettings,
  })),
);

function McpRoute() {
  return (
    <Suspense fallback={null}>
      <McpSetupPage
        externalTools={
          <Suspense fallback={null}>
            <ExternalToolSettings />
          </Suspense>
        }
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/_authenticated/mcp")({
  validateSearch: z.object({
    heygenJob: z.uuid().optional().catch(undefined),
    heygenWorkspace: z.uuid().optional().catch(undefined),
  }),
  head: () => ({ meta: [{ title: "MCP | bento.surf" }] }),
  component: McpRoute,
});
