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

import {
  createBentoMcpServer,
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

const appOrigin = "https://self.example";

function request(body: unknown) {
  return new Request(`${appOrigin}/mcp`, {
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
        new Request(`${appOrigin}/.well-known/oauth-protected-resource`),
        appOrigin,
      );
      expect(response?.status).toBe(200);
      await expect(response?.json()).resolves.toMatchObject({
        resource: `${appOrigin}/mcp`,
        authorization_servers: ["https://example.supabase.co/auth/v1"],
      });
    } finally {
      process.env.SUPABASE_URL = previous;
    }
  });

  it("rejects MCP metadata and requests on an unrelated host", async () => {
    const metadata = await handleBentoMcpRequest(
      new Request("https://attacker.example/.well-known/oauth-protected-resource"),
      appOrigin,
    );
    const response = await handleBentoMcpRequest(
      new Request("https://attacker.example/mcp"),
      appOrigin,
    );

    expect(metadata).toBeNull();
    expect(response).toBeNull();
  });

  it("challenges unauthenticated MCP requests", async () => {
    const response = await handleBentoMcpRequest(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      appOrigin,
      async () => {
        throw new (await import("./request-security.server")).RequestHttpError(401, "Unauthorized");
      },
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });
});

describe("Bento MCP tools", () => {
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

    mcpMocks.requirePlanEntitlement.mockResolvedValue("store");
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
    const handler = createMcpHandler(() => createBentoMcpServer(authInfo, appOrigin));
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
      ]),
    );
    const storeTool = toolsPayload.result.tools.find(
      (tool: { name: string }) => tool.name === "get_store_workspace",
    );
    const audienceTool = toolsPayload.result.tools.find(
      (tool: { name: string }) => tool.name === "manage_audience",
    );
    expect(storeTool.inputSchema.properties.publicationId).toMatchObject({ format: "uuid" });
    expect(JSON.stringify(audienceTool.inputSchema)).toContain("publicationId");

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
    const handler = createMcpHandler(() => createBentoMcpServer(authInfo, appOrigin, operations));

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
      expect.objectContaining({ asDraft: false, publishNow: true }),
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

  it("maps page, product, and calendar mutations to the creator operations", async () => {
    const mutatePage = vi.fn(async () => ({
      id: "page-1",
      user_id: authInfo.extra?.userId as string,
      name: "Resources",
      slug: "resources",
      position: 1,
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
    const handler = createMcpHandler(() => createBentoMcpServer(authInfo, appOrigin, operations));

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
