export type McpTool = { name: string; description?: string; inputSchema?: unknown };

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

function parseEventStream(body: string) {
  const responses: JsonRpcResponse[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (!value || value === "[DONE]") continue;
    responses.push(JSON.parse(value) as JsonRpcResponse);
  }
  return responses.at(-1) || null;
}

async function parseMcpResponse(response: Response) {
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("text/event-stream")
    ? parseEventStream(text)
    : (JSON.parse(text) as JsonRpcResponse);
}

export class McpHttpClient {
  private readonly endpoint: string;
  private readonly accessToken: string;
  private readonly fetcher: typeof fetch;
  private sessionId: string | null = null;
  private initialized = false;
  private requestId = 0;
  private readonly protocolVersion = "2025-06-18";

  constructor(input: { endpoint: string; accessToken: string; fetch?: typeof fetch }) {
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "https:") throw new Error("MCP endpoints must use HTTPS.");
    this.endpoint = endpoint.toString();
    this.accessToken = input.accessToken;
    this.fetcher = input.fetch || fetch;
  }

  private async post(payload: Record<string, unknown>) {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": this.protocolVersion,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("MCP authorization expired.");
    }
    if (!response.ok) throw new Error(`MCP request failed (${response.status}).`);
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    const message = await parseMcpResponse(response);
    if (message?.error) throw new Error(message.error.message || "MCP tool failed.");
    return message?.result;
  }

  private async initialize() {
    if (this.initialized) return;
    const id = ++this.requestId;
    await this.post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: "bento-content", version: "1.0.0" },
      },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    this.initialized = true;
  }

  private async request(method: string, params: Record<string, unknown>) {
    await this.initialize();
    return this.post({ jsonrpc: "2.0", id: ++this.requestId, method, params });
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return (await this.request("tools/call", { name, arguments: args })) as Record<string, unknown>;
  }
}
