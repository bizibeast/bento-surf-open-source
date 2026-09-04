import { createFileRoute } from "@tanstack/react-router";
import { McpSetupPage } from "./mcp.setup";

export const Route = createFileRoute("/_authenticated/mcp")({
  head: () => ({ meta: [{ title: "MCP | bento.surf" }] }),
  component: McpSetupPage,
});
