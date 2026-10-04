import { describe, expect, it, vi } from "vitest";
import { McpHttpClient } from "./mcp-http.server";

function json(value: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Streamable HTTP MCP client", () => {
  it("initializes once and carries the authenticated MCP session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
          { "mcp-session-id": "session-1" },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        json({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "list_meetings" }] } }),
      );
    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      accessToken: "access-token",
      fetch: fetcher,
    });

    await expect(client.listTools()).resolves.toEqual([{ name: "list_meetings" }]);
    const [, init] = fetcher.mock.calls[2];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("mcp-session-id")).toBe("session-1");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("parses JSON-RPC responses delivered as server-sent events", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      accessToken: "access-token",
      fetch: fetcher,
    });
    await expect(client.callTool("get_account_info", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
  });
});
