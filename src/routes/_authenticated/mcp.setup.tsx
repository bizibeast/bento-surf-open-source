import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/mcp/setup")({
  head: () => ({ meta: [{ title: "MCP | bento.surf" }] }),
  component: lazyRouteComponent(() => import("./-mcp-setup-page"), "McpSetupPage"),
});
