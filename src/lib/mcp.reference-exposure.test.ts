import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBentoMcpServer, createChatGptMcpServer, handleBentoMcpRequest } from "./mcp.server";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock("./request-security.server", async () => ({
  ...(await vi.importActual<typeof import("./request-security.server")>(
    "./request-security.server",
  )),
  enforceRequestRateLimit: vi.fn(),
}));
const read = vi.hoisted(() => vi.fn());
vi.mock("./content-reference-jobs.server", () => ({
  readContentReference: read,
  listContentReferences: vi.fn(),
}));
const auth: AuthInfo = {
  token: "test-token-that-is-long-enough",
  clientId: "staging-test-client",
  scopes: ["openid"],
  extra: { userId: "22222222-2222-4222-8222-222222222222" },
};
const workspaceId = "11111111-1111-4111-8111-111111111111";
const jobId = "33333333-3333-4333-8333-333333333333";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const REFERENCE_TOOLS = [
  "analyze_content_reference",
  "create_video_frame_grid",
  "get_content_reference",
  "create_content_from_reference",
];

describe("reference tools on MCP endpoints", () => {
  function rpcFor(factory: typeof createBentoMcpServer | typeof createChatGptMcpServer) {
    vi.stubEnv("BENTO_V2_REFERENCE_ANALYSIS_ENABLED", "true");
    vi.stubEnv("BENTO_V2_STUDIO_ENABLED", "true");
    const resolve = vi.fn(async (_userId: string, requested: string) => {
      if (requested !== workspaceId) throw new Error("Foreign workspace");
      return workspaceId;
    });
    const server = factory(auth, "https://mcp.test.bento.surf", {
      resolveMcpWorkspaceId: resolve,
    } as never);
    const handler = createMcpHandler(() => server);
    return async function rpc(method: string, params: unknown) {
      const response = await handler.fetch(
        new Request("https://mcp.test.bento.surf/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        { authInfo: auth },
      );
      const text = await response.text();
      return text.startsWith("event:")
        ? JSON.parse(text.split("data: ")[1].split("\n")[0])
        : JSON.parse(text);
    };
  }

  it("advertises and executes authenticated reference reads on /mcp", async () => {
    const rpc = rpcFor(createBentoMcpServer);
    const listed = await rpc("tools/list", {});
    const names = listed.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["run_free_media_tool", "transcribe_free_audio", ...REFERENCE_TOOLS]),
    );
    read.mockResolvedValue({ id: jobId, status: "ready" });
    const result = await rpc("tools/call", {
      name: "get_content_reference",
      arguments: { workspaceId, jobId },
    });
    expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, authUserId: auth.extra!.userId }),
      jobId,
    );
    read.mockClear();
    const rejected = await rpc("tools/call", {
      name: "get_content_reference",
      arguments: { workspaceId: jobId, jobId },
    });
    expect(rejected.result.isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps reference tools and free-tool runners off the ChatGPT catalog", async () => {
    const rpc = rpcFor(createChatGptMcpServer);
    const listed = await rpc("tools/list", {});
    const names = listed.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("transcribe_free_audio");
    for (const name of ["run_free_media_tool", ...REFERENCE_TOOLS]) {
      expect(names).not.toContain(name);
    }
  });
  it("routes staging MCP metadata to the staging authorization server", async () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("SUPABASE_URL", "https://pjraekywkqilhaqrxzpe.supabase.co");
    const response = await handleBentoMcpRequest(
      new Request("https://mcp.test.bento.surf/.well-known/oauth-protected-resource/chatgpt/mcp"), "https://mcp.test.bento.surf",
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      resource: "https://mcp.test.bento.surf/chatgpt/mcp",
      authorization_servers: ["https://pjraekywkqilhaqrxzpe.supabase.co/auth/v1"],
    });
  });
});
