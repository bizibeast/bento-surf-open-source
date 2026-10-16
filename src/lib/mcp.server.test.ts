import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => ({
  from: vi.fn(),
  requirePlanEntitlement: vi.fn(),
  enforceRequestRateLimit: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mcpMocks.from },
}));

vi.mock("./plan.server", async () => ({
  ...(await vi.importActual<typeof import("./plan.server")>("./plan.server")),
  requirePlanEntitlement: mcpMocks.requirePlanEntitlement,
}));

vi.mock("./request-security.server", async () => ({
  ...(await vi.importActual<typeof import("./request-security.server")>(
    "./request-security.server",
  )),
  enforceRequestRateLimit: mcpMocks.enforceRequestRateLimit,
}));

import { socialPostInputSchema } from "./social-scheduler";
import { RequestHttpError } from "./request-security.server";
import {
  createBentoMcpServer,
  createBentoAppTools,
  defaultBentoMcpOperations,
  handleBentoMcpRequest,
} from "./mcp.server";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY ||= "test-publishable-key";

const authInfo: AuthInfo = {
  token: "test-bearer-token-that-is-long-enough",
  clientId: "test-client",
  scopes: ["openid", "email", "profile"],
  extra: { userId: "00000000-0000-4000-8000-000000000001" },
};

function request(body: unknown) {
  return new Request("http://localhost:8080/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${authInfo.token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });
}

const CHATGPT_ORIGINS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
];

function expectChatGptCors(response: Response | null | undefined, origin: string) {
  expect(response?.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response?.headers.get("access-control-allow-methods")).toBe("POST, GET, DELETE, OPTIONS");
  expect(response?.headers.get("access-control-allow-headers")).toBe(
    "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  expect(response?.headers.get("access-control-expose-headers")).toBe(
    "mcp-session-id, www-authenticate",
  );
  expect(response?.headers.get("vary")?.toLowerCase()).toContain("origin");
}

function handleBrowserMcpRequest(request: Request, authenticate?: () => Promise<AuthInfo>) {
  return handleBentoMcpRequest(request, "http://localhost:8080", authenticate);
}

async function payload(response: Response) {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    return JSON.parse(data || "null");
  }
  return JSON.parse(body);
}

describe("Bento MCP HTTP surface", () => {
  it("publishes OAuth protected-resource metadata", async () => {
    const previous = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    try {
      const response = await handleBentoMcpRequest(
        new Request("http://localhost:8080/.well-known/oauth-protected-resource"),
        "http://localhost:8080",
      );
      expect(response?.status).toBe(200);
      await expect(response?.json()).resolves.toMatchObject({
        resource: "http://localhost:8080/mcp",
        authorization_servers: ["https://example.supabase.co/auth/v1"],
      });
    } finally {
      process.env.SUPABASE_URL = previous;
    }
  });

  it("leaves the app-host MCP page to the frontend router", async () => {
    const response = await handleBentoMcpRequest(
      new Request("http://localhost:8080/mcp"),
      "https://app.example.com",
    );
    expect(response).toBeNull();
  });

  it("challenges unauthenticated MCP requests", async () => {
    const response = await handleBentoMcpRequest(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      "http://localhost:8080",
      async () => {
        throw new (await import("./request-security.server")).RequestHttpError(401, "Unauthorized");
      },
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });
  it("rejects other browser origins before the token is checked", async () => {
    const authenticate = vi.fn(async () => authInfo);
    for (const origin of ["https://evil.example", "https://chatgpt.com.evil.example", "null"]) {
      const response = await handleBrowserMcpRequest(
        new Request("http://localhost:8080/mcp", {
          method: "POST",
          headers: {
            origin,
            authorization: `Bearer ${authInfo.token}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
        authenticate,
      );
      expect(response?.status).toBe(403);
      await expect(response?.json()).resolves.toEqual({ error: "Invalid origin" });
      expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(authenticate).not.toHaveBeenCalled();
    const preflight = await handleBrowserMcpRequest(
      new Request("http://localhost:8080/mcp", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      }),
    );
    expect(preflight?.status).toBe(403);
    expect(preflight?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each(CHATGPT_ORIGINS)(
    "lets %s reach authentication and exposes the 401 challenge",
    async (origin) => {
      const authenticate = vi.fn(async () => {
        throw new RequestHttpError(401, "Unauthorized");
      });
      const response = await handleBrowserMcpRequest(
        new Request("http://localhost:8080/mcp", {
          method: "POST",
          headers: {
            origin,
            authorization: "Bearer not-a-real-token-value",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: "{}",
        }),
        authenticate,
      );
      expect(authenticate).toHaveBeenCalledOnce();
      expect(response?.status).toBe(401);
      expect(response?.headers.get("www-authenticate")).toContain(
        "/.well-known/oauth-protected-resource",
      );
      expectChatGptCors(response, origin);
    },
  );

  it.each(CHATGPT_ORIGINS)("answers the %s preflight with CORS", async (origin) => {
    const response = await handleBrowserMcpRequest(
      new Request("http://localhost:8080/mcp", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization, content-type, mcp-session-id, mcp-protocol-version",
        },
      }),
    );
    expect(response?.status).toBe(204);
    expect(response?.headers.get("allow")).toBe("POST, GET, DELETE, OPTIONS");
    expectChatGptCors(response, origin);
  });

  it("keeps a same-origin and origin-less MCP call on the existing path", async () => {
    const authenticate = vi.fn(async () => {
      throw new RequestHttpError(401, "Unauthorized");
    });
    const sameOrigin = await handleBrowserMcpRequest(
      new Request("http://localhost:8080/mcp", {
        method: "POST",
        headers: { origin: "http://localhost:8080", "content-type": "application/json" },
        body: "{}",
      }),
      authenticate,
    );
    expect(sameOrigin?.status).toBe(401);
    expect(sameOrigin?.headers.get("access-control-allow-origin")).toBeNull();
    const browserless = await handleBrowserMcpRequest(
      new Request("http://localhost:8080/mcp", { method: "OPTIONS" }),
    );
    expect(browserless?.status).toBe(204);
    expect(browserless?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sends CORS on MCP discovery metadata for ChatGPT origins only", async () => {
    const paths = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ];
    for (const path of paths) {
      const allowed = await handleBrowserMcpRequest(
        new Request(`http://localhost:8080${path}`, {
          headers: { origin: "https://platform.openai.com" },
        }),
      );
      expect(allowed?.status).toBe(200);
      expectChatGptCors(allowed, "https://platform.openai.com");
      const blocked = await handleBrowserMcpRequest(
        new Request(`http://localhost:8080${path}`, {
          headers: { origin: "https://evil.example" },
        }),
      );
      expect(blocked?.status).toBe(200);
      expect(blocked?.headers.get("access-control-allow-origin")).toBeNull();
      expect(blocked?.headers.get("vary")?.toLowerCase()).toContain("origin");
    }
  });

  it("adds CORS to an authenticated MCP response for an allowed origin", async () => {
    const response = await handleBrowserMcpRequest(
      new Request("http://localhost:8080/mcp", {
        method: "POST",
        headers: {
          origin: "https://chatgpt.com",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${authInfo.token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      async () => authInfo,
    );
    expect(response?.status).toBe(200);
    expectChatGptCors(response, "https://chatgpt.com");
    const body = await payload(response!);
    expect(body.result.tools.length).toBeGreaterThan(0);
  });
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

/** Pins the hints OpenAI reads from tools/list. Idempotent is omitted unless true. */
const bentoMcpToolAnnotations = {
  get_bento_overview: readOnlyAnnotations,
  get_content_brain: readOnlyAnnotations,
  manage_content_brain: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  get_content_media: readOnlyAnnotations,
  manage_content_media: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  get_content_routines: readOnlyAnnotations,
  manage_content_routine: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  get_content_agent: readOnlyAnnotations,
  manage_content_agent: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  get_content_discover: readOnlyAnnotations,
  manage_content_discover: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  list_social_accounts: readOnlyAnnotations,
  upload_media: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  list_social_posts: readOnlyAnnotations,
  search_stock_photos: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  resolve_post_media: readOnlyAnnotations,
  create_social_post: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  list_auto_dm_automations: readOnlyAnnotations,
  save_auto_dm_automation: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  set_auto_dm_enabled: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  delete_auto_dm_automation: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  list_pages: readOnlyAnnotations,
  list_products: readOnlyAnnotations,
  list_bookings: readOnlyAnnotations,
  get_priority_dm_conversations: readOnlyAnnotations,
  send_priority_dm_message: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  set_priority_dm_closed: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  get_scheduler_workspace: readOnlyAnnotations,
  manage_scheduler: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  manage_page: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  manage_block: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  get_store_workspace: readOnlyAnnotations,
  manage_product: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  manage_discount_code: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  manage_order_bump: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  manage_audience: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  get_calendar_workspace: readOnlyAnnotations,
  manage_calendar: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  get_community_workspace: readOnlyAnnotations,
  manage_community: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  get_profile_workspace: readOnlyAnnotations,
  update_profile: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  get_analytics_workspace: readOnlyAnnotations,
  get_integration_workspace: readOnlyAnnotations,
  get_earn_workspace: readOnlyAnnotations,
  manage_earn: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
};

describe("Bento MCP tools", () => {
  it("pins read, destructive, idempotent, and open-world hints for every tool", async () => {
    const handler = createMcpHandler(() =>
      createBentoMcpServer(authInfo, "https://mcp.example.test"),
    );
    const response = await handler.fetch(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      { authInfo },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await payload(response);
    const actual = Object.fromEntries(
      body.result.tools.map((tool: { name: string; annotations?: unknown }) => [
        tool.name,
        tool.annotations,
      ]),
    );
    expect(actual).toEqual(bentoMcpToolAnnotations);
  });

  it("preserves advanced Auto-DM configuration and rejects unowned partial updates", async () => {
    const automationId = "00000000-0000-4000-8000-000000000020";
    const connectionId = "00000000-0000-4000-8000-000000000010";
    const current = {
      id: automationId,
      user_id: authInfo.extra?.userId,
      connection_id: connectionId,
      name: "Lead magnet",
      trigger_type: "dm_keyword",
      keywords: ["guide"],
      excluded_keywords: ["ignore"],
      match_type: "exact",
      media_scope: "specific",
      media_ids: ["media-1"],
      reply_message: "Here is your guide",
      public_reply_enabled: true,
      public_reply_message: "Check your inbox",
      public_reply_messages: ["Check your inbox"],
      opening_message: "Tap below to continue",
      confirmation_button_label: "Send it",
      email_capture_enabled: true,
      email_prompt_message: "What email should receive it?",
      email_marketing_consent_enabled: true,
      follow_gate_enabled: false,
      follow_prompt_message: "Follow this account, then tap I’ve followed.",
      follow_max_rechecks: 2,
      follow_fail_action: "withhold",
      reply_button_label: "Open guide",
      reply_button_url: "https://example.com/guide",
      enabled: false,
    };
    let update: Record<string, unknown> | undefined;
    const query = (data: unknown) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) chain[method] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data, error: null }));
      return chain;
    };

    mcpMocks.requirePlanEntitlement.mockResolvedValue("creator_plus");
    mcpMocks.enforceRequestRateLimit.mockResolvedValue(undefined);
    mcpMocks.from.mockImplementation((table: string) => {
      if (table === "social_connections") {
        return { select: vi.fn(() => query({ id: connectionId })) };
      }
      if (table === "instagram_dm_automations") {
        return {
          select: vi.fn(() => query(current)),
          update: vi.fn((row: Record<string, unknown>) => {
            update = row;
            return query({ ...current, ...row });
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    await defaultBentoMcpOperations.saveAutoDmAutomation(
      authInfo.extra?.userId as string,
      "instagram",
      {
        id: automationId,
        name: "Renamed lead magnet",
      },
    );

    expect(update).toMatchObject({
      name: "Renamed lead magnet",
      excluded_keywords: ["ignore"],
      media_scope: "specific",
      media_ids: ["media-1"],
      public_reply_enabled: true,
      public_reply_message: "Check your inbox",
      public_reply_messages: ["Check your inbox"],
      opening_message: "Tap below to continue",
      confirmation_button_label: "Send it",
      email_capture_enabled: true,
      email_prompt_message: "What email should receive it?",
      email_marketing_consent_enabled: true,
      follow_gate_enabled: false,
      follow_prompt_message: "Follow this account, then tap I’ve followed.",
      follow_max_rechecks: 2,
      follow_fail_action: "withhold",
      reply_button_label: "Open guide",
      reply_button_url: "https://example.com/guide",
      enabled: false,
    });

    mcpMocks.requirePlanEntitlement.mockClear();
    mcpMocks.from.mockImplementation((table: string) => {
      if (table === "instagram_dm_automations") {
        return { select: vi.fn(() => query(null)) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    await expect(
      defaultBentoMcpOperations.saveAutoDmAutomation(
        authInfo.extra?.userId as string,
        "instagram",
        { id: "00000000-0000-4000-8000-000000000099", name: "Unowned" },
      ),
    ).rejects.toThrow("The instagram automation could not be loaded.");
    expect(mcpMocks.requirePlanEntitlement).not.toHaveBeenCalled();
  });

  it("advertises the Bento toolset and importable skill", async () => {
    const handler = createMcpHandler(() => createBentoMcpServer(authInfo, "http://localhost:8080"));
    const toolsResponse = await handler.fetch(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      { authInfo },
    );
    expect(toolsResponse.status, await toolsResponse.clone().text()).toBe(200);
    const toolsPayload = await payload(toolsResponse);
    expect(toolsPayload.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        "upload_media",
        "create_social_post",
        "save_auto_dm_automation",
        "manage_page",
        "manage_block",
        "get_store_workspace",
        "manage_product",
        "manage_calendar",
        "manage_community",
        "get_profile_workspace",
        "update_profile",
        "get_analytics_workspace",
        "get_integration_workspace",
        "get_earn_workspace",
        "manage_earn",
        "list_products",
        "list_bookings",
        "get_priority_dm_conversations",
        "send_priority_dm_message",
        "set_priority_dm_closed",
        "get_scheduler_workspace",
        "manage_scheduler",
        "get_content_brain",
        "manage_content_brain",
        "get_content_media",
        "manage_content_media",
        "get_content_routines",
        "manage_content_routine",
        "get_content_agent",
        "manage_content_agent",
        "get_content_discover",
        "manage_content_discover",
      ]),
    );
    const appTools = createBentoAppTools(
      { userId: String(authInfo.extra!.userId), accessToken: authInfo.token, supabase: {} as any },
      "https://app.bento.surf",
    );
    expect([...appTools.keys()].sort()).toEqual(
      toolsPayload.result.tools
        .map((tool: { name: string }) => tool.name)
        .filter((name: string) => !["upload_media", "manage_content_agent"].includes(name))
        .sort(),
    );
    expect(appTools.get("create_social_post")?.readOnly).toBe(false);
    expect(appTools.get("list_social_accounts")?.readOnly).toBe(true);
    const storeTool = toolsPayload.result.tools.find(
      (tool: { name: string }) => tool.name === "get_store_workspace",
    );
    const audienceTool = toolsPayload.result.tools.find(
      (tool: { name: string }) => tool.name === "manage_audience",
    );
    const socialPostTool = toolsPayload.result.tools.find(
      (tool: { name: string }) => tool.name === "create_social_post",
    );
    expect(storeTool.inputSchema.properties.publicationId).toMatchObject({ format: "uuid" });
    expect(JSON.stringify(audienceTool.inputSchema)).toContain("publicationId");
    expect(
      socialPostTool.inputSchema.properties.providerSettings.properties.instagram.properties,
    ).toMatchObject({
      trialReel: { type: "boolean" },
      graduationStrategy: { enum: ["MANUAL", "SS_PERFORMANCE"], default: "MANUAL" },
    });

    const skillsResponse = await handler.fetch(
      request({ jsonrpc: "2.0", id: 2, method: "skills/list", params: {} }),
      { authInfo },
    );
    const skillsPayload = await payload(skillsResponse);
    expect(skillsPayload.result.skills[0]).toMatchObject({
      uri: "skill://bento/bento/SKILL.md",
      frontmatter: { name: "bento" },
    });
    expect(skillsPayload.result.skills[0].resources[0].digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("pins tools/list safety annotations", async () => {
    const handler = createMcpHandler(() => createBentoMcpServer(authInfo, "http://localhost:8080"));
    const response = await handler.fetch(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      { authInfo },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const tools = (await payload(response)).result.tools as {
      name: string;
      annotations?: Record<string, boolean>;
    }[];
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual({
      get_bento_overview: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      get_content_brain: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_content_brain: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      get_content_media: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_content_media: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      get_content_routines: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_content_routine: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
      get_content_agent: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_content_agent: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      get_content_discover: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_content_discover: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      list_social_accounts: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      upload_media: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      list_social_posts: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      create_social_post: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      list_auto_dm_automations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      save_auto_dm_automation: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      set_auto_dm_enabled: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      delete_auto_dm_automation: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
      list_pages: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      list_products: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      list_bookings: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      get_priority_dm_conversations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      send_priority_dm_message: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      set_priority_dm_closed: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      get_scheduler_workspace: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_scheduler: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      manage_page: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      manage_block: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      get_store_workspace: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_product: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      manage_discount_code: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      manage_order_bump: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      manage_audience: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      get_calendar_workspace: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_calendar: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      get_community_workspace: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_community: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      get_profile_workspace: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      update_profile: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
      get_analytics_workspace: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      get_integration_workspace: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      get_earn_workspace: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      manage_earn: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    });
  });

  it("routes Content reads and edits through the authorized creator ID", async () => {
    const getMcpContentBrain = vi.fn(async () => ({
      profile: {
        goal: "consistent_publishing" as const,
        nicheKeywords: [],
        language: "en",
        region: "global",
        timezone: "UTC",
        platformFrequencies: {},
      },
      items: [],
      sources: [],
      indexing: null,
      humanSummary: "",
    }));
    const getMcpContentRoutines = vi.fn(async () => ({ routines: [], activity: [] }));
    const manageMcpContentBrain = vi.fn(async () => ({ id: "brain-1" }));
    const manageMcpContentMedia = vi.fn(async () => ({ id: "media-1" }));
    const manageMcpContentRoutine = vi.fn(async () => ({ id: "routine-1", nextRunAt: null }));
    const manageMcpContentDiscover = vi.fn(async () => ({ id: "recommendation-1", saved: true }));
    const operations = {
      ...defaultBentoMcpOperations,
      getMcpContentBrain,
      getMcpContentRoutines,
      manageMcpContentBrain,
      manageMcpContentMedia,
      manageMcpContentRoutine,
      manageMcpContentDiscover,
    };
    const handler = createMcpHandler(() =>
      createBentoMcpServer(authInfo, "https://app.example.com", operations),
    );
    const calls = [
      { name: "get_content_brain", arguments: {} },
      { name: "get_content_routines", arguments: {} },
      {
        name: "manage_content_brain",
        arguments: {
          action: "lock_item",
          id: "00000000-0000-4000-8000-000000000010",
          locked: true,
        },
      },
      { name: "manage_content_media", arguments: { action: "set_hero", id: null, slot: 1 } },
      {
        name: "manage_content_routine",
        arguments: { action: "pause", id: "00000000-0000-4000-8000-000000000011", paused: true },
      },
      {
        name: "manage_content_discover",
        arguments: { action: "save_item", id: "00000000-0000-4000-8000-000000000012" },
      },
    ];
    for (const [index, call] of calls.entries()) {
      const response = await handler.fetch(
        request({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: call }),
        { authInfo },
      );
      expect(response.status).toBe(200);
      expect((await payload(response)).result.isError).not.toBe(true);
    }
    for (const operation of [
      getMcpContentBrain,
      getMcpContentRoutines,
      manageMcpContentBrain,
      manageMcpContentMedia,
      manageMcpContentRoutine,
      manageMcpContentDiscover,
    ]) {
      expect(operation).toHaveBeenCalledWith(
        authInfo.extra?.userId,
        ...(operation === getMcpContentBrain || operation === getMcpContentRoutines
          ? []
          : [expect.any(Object)]),
      );
    }
  });

  it("passes draft and immediate-publish actions through the real scheduler schema without a schedule time", async () => {
    const save = vi.fn(async (_userId: string, input: unknown) => ({
      id: "saved",
      input: socialPostInputSchema.parse(input),
    }));
    const tools = createBentoAppTools(
      { userId: String(authInfo.extra!.userId), accessToken: authInfo.token, supabase: {} as any },
      "https://app.bento.surf",
      { ...defaultBentoMcpOperations, saveSocialPostForUser: save },
    );
    for (const mode of ["draft", "publish_now"]) {
      await tools.get("create_social_post")!.execute({
        body: "Review this post",
        mode,
        connectionIds: mode === "draft" ? [] : ["00000000-0000-4000-8000-000000000001"],
      });
    }
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(
      1,
      authInfo.extra!.userId,
      expect.objectContaining({ scheduledAt: null, asDraft: true, publishNow: false }),
    );
    expect(save).toHaveBeenNthCalledWith(
      2,
      authInfo.extra!.userId,
      expect.objectContaining({ scheduledAt: null, asDraft: false, publishNow: true }),
    );
  });

  it("maps publish-now and Auto-DM tool calls to the Bento operations", async () => {
    const saveSocialPostForUser = vi.fn(async (_userId: string, input: unknown) => ({
      id: "post-1",
      input,
    }));
    const saveAutoDmAutomation = vi.fn(
      async (_userId: string, platform: "instagram" | "facebook" | "twitter", input: unknown) => ({
        id: "automation-1",
        platform,
        input,
      }),
    );
    const operations = {
      ...defaultBentoMcpOperations,
      saveSocialPostForUser,
      saveAutoDmAutomation,
    };
    const handler = createMcpHandler(() =>
      createBentoMcpServer(authInfo, "http://localhost:8080", operations),
    );

    const postResponse = await handler.fetch(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_social_post",
          arguments: {
            body: "Launch day",
            connectionIds: ["00000000-0000-4000-8000-000000000010"],
            providerSettings: {
              instagram: { trialReel: true, graduationStrategy: "MANUAL" },
            },
            mode: "publish_now",
          },
        },
      }),
      { authInfo },
    );
    expect(postResponse.status).toBe(200);
    expect((await payload(postResponse)).result.isError).not.toBe(true);
    expect(saveSocialPostForUser).toHaveBeenCalledWith(
      authInfo.extra?.userId,
      expect.objectContaining({
        asDraft: false,
        publishNow: true,
        providerSettings: {
          instagram: { trialReel: true, graduationStrategy: "MANUAL" },
        },
      }),
    );

    const automationResponse = await handler.fetch(
      request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "save_auto_dm_automation",
          arguments: {
            platform: "instagram",
            connectionId: "00000000-0000-4000-8000-000000000010",
            name: "Lead magnet",
            triggerType: "dm_keyword",
            keywords: ["guide"],
            replyMessage: "Here is your guide",
          },
        },
      }),
      { authInfo },
    );
    expect(automationResponse.status).toBe(200);
    expect((await payload(automationResponse)).result.isError).not.toBe(true);
    expect(saveAutoDmAutomation).toHaveBeenCalledWith(
      authInfo.extra?.userId,
      "instagram",
      expect.objectContaining({ name: "Lead magnet", keywords: ["guide"] }),
    );
  });

  it("maps creator workspace mutations to the matching operations", async () => {
    const getPriorityDmConversations = vi.fn(async () => [{ id: "request-1", status: "unread" }]);
    const sendPriorityDmMessage = vi.fn(async () => ({ id: "message-1" }));
    const setPriorityDmClosed = vi.fn(async () => ({ id: "request-1", closed: true }));
    const getSchedulerWorkspace = vi.fn(async () => ({
      accounts: [],
      posts: [],
      postingSchedule: null,
    }));
    const manageScheduler = vi.fn(async () => ({
      accounts: [],
      posts: [],
      postingSchedule: null,
    }));
    const mcpOperations = {
      ...defaultBentoMcpOperations,
      getPriorityDmConversations,
      sendPriorityDmMessage,
      setPriorityDmClosed,
      getSchedulerWorkspace,
      manageScheduler,
    };
    const mcpHandler = createMcpHandler(() =>
      createBentoMcpServer(authInfo, "http://localhost:8080", mcpOperations),
    );

    for (const call of [
      { name: "get_priority_dm_conversations", arguments: { filter: "open", limit: 25 } },
      {
        name: "send_priority_dm_message",
        arguments: {
          requestId: "00000000-0000-4000-8000-000000000040",
          body: "Thanks for reaching out.",
        },
      },
      {
        name: "set_priority_dm_closed",
        arguments: {
          requestId: "00000000-0000-4000-8000-000000000040",
          closed: true,
        },
      },
      { name: "get_scheduler_workspace", arguments: {} },
      {
        name: "manage_scheduler",
        arguments: {
          action: "cancel_post",
          id: "00000000-0000-4000-8000-000000000050",
        },
      },
    ]) {
      const response = await mcpHandler.fetch(
        request({ jsonrpc: "2.0", id: call.name, method: "tools/call", params: call }),
        { authInfo },
      );
      expect(response.status).toBe(200);
      expect((await payload(response)).result.isError).not.toBe(true);
    }

    expect(getPriorityDmConversations).toHaveBeenCalledWith(authInfo.extra?.userId, "open", 25);
    expect(sendPriorityDmMessage).toHaveBeenCalledWith(
      authInfo.extra?.userId,
      expect.objectContaining({ body: "Thanks for reaching out." }),
    );
    expect(setPriorityDmClosed).toHaveBeenCalledWith(
      authInfo.extra?.userId,
      expect.objectContaining({ closed: true }),
    );
    expect(manageScheduler).toHaveBeenCalledWith(
      authInfo.extra?.userId,
      expect.objectContaining({ action: "cancel_post" }),
    );

    const mutatePage = vi.fn(async () => ({
      id: "page-1",
      user_id: authInfo.extra?.userId as string,
      name: "Resources",
      slug: "resources",
      position: 1,
      system: null,
      is_visible: true,
      url: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }));
    const mutateProduct = vi.fn(async () => ({
      product: { id: "product-1", title: "Creator guide" },
      block: { id: "block-1" },
    }));
    const mutateCalendar = vi.fn(async () => ({ calendar_page_enabled: true }));
    const operations = {
      ...defaultBentoMcpOperations,
      mutatePage,
      mutateProduct,
      mutateCalendar,
    };
    const handler = createMcpHandler(() =>
      createBentoMcpServer(authInfo, "http://localhost:8080", operations),
    );

    for (const call of [
      {
        name: "manage_page",
        arguments: { action: "create", name: "Resources" },
      },
      {
        name: "manage_product",
        arguments: {
          action: "create",
          addToBento: true,
          product: {
            kind: "digital_product",
            title: "Creator guide",
            pricing_type: "one_time",
            price_amount: 1900,
            currency: "usd",
            cta_label: "Get the guide",
            settings: {},
            noindex: false,
          },
        },
      },
      {
        name: "manage_calendar",
        arguments: { action: "set_public_page", enabled: true },
      },
    ]) {
      const response = await handler.fetch(
        request({
          jsonrpc: "2.0",
          id: call.name,
          method: "tools/call",
          params: call,
        }),
        { authInfo },
      );
      expect(response.status).toBe(200);
      expect((await payload(response)).result.isError).not.toBe(true);
    }

    expect(mutatePage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authInfo.extra?.userId }),
      expect.objectContaining({ action: "create", name: "Resources" }),
    );
    expect(mutateProduct).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authInfo.extra?.userId }),
      expect.objectContaining({
        action: "create",
        addToBento: true,
        product: expect.objectContaining({ noindex: false }),
      }),
    );
    expect(mutateCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ userId: authInfo.extra?.userId }),
      { action: "set_public_page", enabled: true },
    );
  });
});

it("imports the selected free photo only at execution and schedules all tailored destinations together", async () => {
  const media = {
    key: "users/owner/stock.jpg",
    url: "https://example.com/stock.jpg",
    mimeType: "image/jpeg",
    name: "Stock photo",
    size: 1024,
  };
  const importPhoto = vi
    .fn()
    .mockResolvedValue({ media, credit: { name: "Sam", url: "https://pixabay.com/photos/42" } });
  const save = vi.fn(async (_userId: string, input: unknown) => ({
    id: "saved",
    input: socialPostInputSchema.parse(input),
  }));
  const tools = createBentoAppTools(
    { userId: String(authInfo.extra!.userId), accessToken: authInfo.token, supabase: {} as any },
    "https://app.bento.surf",
    {
      ...defaultBentoMcpOperations,
      importPostStockPhoto: importPhoto,
      saveSocialPostForUser: save,
    },
  );
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  await tools
    .get("create_social_post")!
    .execute({
      body: "Shared",
      mode: "schedule",
      scheduledAt: "2099-10-22T18:00:00Z",
      timezone: "Asia/Kolkata",
      connectionIds: ids,
      connectionOverrides: {
        [ids[0]]: { bodyOverride: "LinkedIn version" },
        [ids[1]]: { bodyOverride: "X version" },
      },
      stockPhoto: { id: 42, provider: "pixabay" },
    });
  expect(importPhoto).toHaveBeenCalledWith(authInfo.extra!.userId, 42, "pixabay");
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][1]).toMatchObject({
    media: [media],
    connectionIds: ids,
    connectionOverrides: {
      [ids[0]]: { bodyOverride: "LinkedIn version" },
      [ids[1]]: { bodyOverride: "X version" },
    },
    scheduledAt: "2099-10-22T18:00:00Z",
    asDraft: false,
  });
});
