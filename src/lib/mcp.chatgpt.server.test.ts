import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn() },
}));

vi.mock("./plan.server", async () => ({
  ...(await vi.importActual<typeof import("./plan.server")>("./plan.server")),
  requirePlanEntitlement: vi.fn(),
  hasPlanEntitlement: vi.fn(async () => true),
}));

vi.mock("./request-security.server", async () => ({
  ...(await vi.importActual<typeof import("./request-security.server")>(
    "./request-security.server",
  )),
  enforceRequestRateLimit: vi.fn(),
}));

import { RequestHttpError } from "./request-security.server";
import type { ChatGptToolOperations } from "./mcp.chatgpt.server";
import {
  createChatGptMcpServer,
  handleBentoMcpRequest as handleInstanceMcpRequest,
} from "./mcp.server";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY ||= "test-publishable-key";

const authInfo: AuthInfo = {
  token: "test-bearer-token-that-is-long-enough",
  clientId: "test-client",
  scopes: ["openid", "email", "profile"],
  extra: { userId: "00000000-0000-4000-8000-000000000001" },
};

const PAGE = "00000000-0000-4000-8000-000000000010";
const BLOCK = "00000000-0000-4000-8000-000000000011";
const CONN = "00000000-0000-4000-8000-000000000012";
const POST = "00000000-0000-4000-8000-000000000013";
const AUTO = "00000000-0000-4000-8000-000000000014";

const READ_OPS = new Set([
  "getBentoOverview",
  "getProfileWorkspace",
  "listPages",
  "listSocialAccounts",
  "listSocialPosts",
  "getSchedulerWorkspace",
  "getMcpContentBrain",
  "getMcpContentMedia",
  "getAnalyticsWorkspace",
  "listAutoDmAutomations",
]);
const WRITE_OPS = new Set([
  "mutatePage",
  "mutateBlock",
  "reorderPages",
  "saveSocialPostForUser",
  "manageScheduler",
  "uploadMedia",
  "beginMcpMediaUpload",
  "saveAutoDmAutomation",
  "setAutoDmEnabled",
  "deleteAutoDmAutomation",
]);

const TYPE_KEYS = new Set(["$ref", "allOf", "anyOf", "const", "enum", "oneOf", "type"]);
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_CHILD_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const COMMERCE_NAMES =
  /store|product|discount|order_bump|earn|checkout|payment|booking|tip_jar|commerce|manage_/i;
const COMMERCE_FIELDS =
  /^(action|productId|price_amount|discountType|discountValue|checkout|payment|booking|orderBump|earn)$/;

type ListedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePointer(root: unknown, ref: string) {
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current;
}

function schemaProblems(schema: unknown, path: string, root: unknown, problems: string[]) {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => schemaProblems(item, `${path}[${index}]`, root, problems));
    return;
  }
  if (!isRecord(schema)) return;
  if ("$schema" in schema) problems.push(`${path} declares $schema`);
  if (typeof schema.$ref === "string") {
    if (resolvePointer(root, schema.$ref) === undefined)
      problems.push(`${path} has unresolved $ref ${schema.$ref}`);
  } else if (![...TYPE_KEYS].some((key) => key in schema)) {
    problems.push(`${path} has no explicit type`);
  }
  if (typeof schema.pattern === "string" && schema.pattern.length > 120) {
    problems.push(`${path} pattern is ${schema.pattern.length} characters`);
  }
  if (schema.type === "object" && isRecord(schema.properties)) {
    if (!Array.isArray(schema.required)) problems.push(`${path} object is missing required`);
    for (const key of Object.keys(schema.properties)) {
      if (key === "action" || COMMERCE_FIELDS.test(key))
        problems.push(`${path} has disallowed field ${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") continue;
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      for (const [childKey, child] of Object.entries(value))
        schemaProblems(child, `${path}.${key}.${childKey}`, root, problems);
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      value.forEach((item, index) =>
        schemaProblems(item, `${path}.${key}[${index}]`, root, problems),
      );
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      schemaProblems(value, `${path}.${key}`, root, problems);
    }
  }
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

function rpc(url: string, id: number, method: string, params: unknown) {
  return new Request(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${authInfo.token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

function fakeOperations() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return value;
    };
  const pages = {
    pages: [{ id: PAGE, name: "Home", slug: "home" }],
    blocks: [
      { id: BLOCK, page_id: PAGE, type: "heading", content: { text: "Hi" } },
      { id: "commerce-block", page_id: PAGE, type: "commerce", content: { title: "Kit" } },
      { id: "booking-block", page_id: null, type: "booking" },
      { id: "tip-block", page_id: PAGE, type: "tip_jar" },
    ],
  };
  const operations = {
    getBentoOverview: record("getBentoOverview", {
      profile: { username: "ada" },
      plan: { id: "creator", name: "Creator" },
      counts: { pages: 1, products: 4, bookings: 2, socialPosts: 3 },
      features: {
        pages: "https://mcp.example.com/link",
        products: "https://mcp.example.com/store",
        bookings: "https://mcp.example.com/calendar",
        scheduler: "https://mcp.example.com/post-scheduler",
        community: "https://mcp.example.com/community",
      },
    }),
    getProfileWorkspace: record("getProfileWorkspace", {
      profile: { username: "ada" },
      plan: "creator",
      paymentAccounts: [{ provider: "stripe", charges_enabled: true }],
    }),
    listPages: record("listPages", pages),
    mutatePage: record("mutatePage", { id: PAGE }),
    mutateBlock: record("mutateBlock", { id: BLOCK }),
    reorderPages: record("reorderPages", { ok: true }),
    listSocialAccounts: record("listSocialAccounts", []),
    listSocialPosts: record("listSocialPosts", []),
    saveSocialPostForUser: record("saveSocialPostForUser", { id: POST }),
    getSchedulerWorkspace: record("getSchedulerWorkspace", {
      postingSchedule: { timezone: "UTC", slots: [] },
      posts: [
        { id: POST, status: "scheduled", body: "Later" },
        { id: "draft-post", status: "draft", body: "Not yet" },
      ],
      accounts: [{ id: CONN }],
    }),
    manageScheduler: record("manageScheduler", { postingSchedule: { timezone: "UTC" } }),
    getMcpContentBrain: record("getMcpContentBrain", { profile: {} }),
    getMcpContentMedia: record("getMcpContentMedia", { items: [] }),
    uploadMedia: record("uploadMedia", { id: "media" }),
    beginMcpMediaUpload: record("beginMcpMediaUpload", {
      uploadUrl: "https://app.bento.surf/upload",
    }),
    getAnalyticsWorkspace: record("getAnalyticsWorkspace", {
      range: "30d",
      site: { views: 1 },
      dataAccess: { tool: "read_workspace_data" },
    }),
    listAutoDmAutomations: record("listAutoDmAutomations", []),
    saveAutoDmAutomation: record("saveAutoDmAutomation", { id: AUTO }),
    setAutoDmEnabled: record("setAutoDmEnabled", { id: AUTO, enabled: false }),
    deleteAutoDmAutomation: record("deleteAutoDmAutomation", { id: AUTO, deleted: true }),
  } satisfies ChatGptToolOperations;
  return { calls, operations };
}

function chatGptHandler(operations: ChatGptToolOperations) {
  return createMcpHandler(() =>
    createChatGptMcpServer(authInfo, "https://mcp.example.com", operations),
  );
}

async function listedTools(operations = fakeOperations().operations) {
  const response = await chatGptHandler(operations).fetch(
    rpc("https://mcp.example.com/chatgpt/mcp", 1, "tools/list", {}),
    { authInfo },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await payload(response)).result.tools as ListedTool[];
}

const samples: Record<string, Record<string, unknown>> = {
  get_bento_overview: {},
  get_profile: {},
  list_pages: {},
  get_page: { id: PAGE },
  create_page: { name: "About" },
  update_page: { id: PAGE, name: "About" },
  reorder_pages: { pageIds: [PAGE] },
  delete_page: { id: PAGE },
  list_page_blocks: {},
  get_page_block: { id: BLOCK },
  create_page_block: { type: "heading" },
  update_page_block: { id: BLOCK, content: { text: "Hi" } },
  reorder_page_blocks: { items: [{ id: BLOCK, x: 0, y: 0, width: 2, height: 2, position: 0 }] },
  delete_page_block: { id: BLOCK },
  list_social_accounts: {},
  list_social_posts: {},
  draft_social_post: { body: "Hello" },
  schedule_social_post: {
    body: "Hello",
    connectionIds: [CONN],
    scheduledAt: "2030-01-01T00:00:00+00:00",
  },
  update_social_post: { id: POST, body: "Hello", connectionIds: [CONN], media: [] },
  cancel_social_post: { id: POST },
  get_content_calendar: {},
  update_content_calendar: {
    schedule: { timezone: "UTC", slots: [{ day: 1, time: "09:00" }] },
  },
  get_content_brain: {},
  get_content_media: {},
  upload_media: {
    fileName: "a.png",
    mimeType: "image/png",
    kind: "image",
    sourceUrl: "https://example.com/a.png",
  },
  begin_media_upload: { fileName: "a.png", mimeType: "image/png", kind: "image", size: 1024 },
  get_analytics: {},
  list_auto_dm_automations: {},
  create_auto_dm_automation: {
    platform: "instagram",
    connectionId: CONN,
    name: "Welcome",
    triggerType: "keyword",
    replyMessage: "Hi",
  },
  update_auto_dm_automation: { platform: "instagram", id: AUTO, name: "Welcome" },
  set_auto_dm_enabled: { platform: "instagram", id: AUTO, enabled: false },
  delete_auto_dm_automation: { platform: "instagram", id: AUTO },
};

describe("ChatGPT MCP catalog", () => {
  it("lists one operation per tool, with strict schemas and explicit annotations", async () => {
    const tools = await listedTools();
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(25);
    expect(names.length).toBeLessThanOrEqual(40);
    expect(names.filter((name) => COMMERCE_NAMES.test(name))).toEqual([]);
    expect(names.some((name) => name.startsWith("manage_"))).toBe(false);

    const problems: string[] = [];
    for (const tool of tools) {
      const annotations = tool.annotations || {};
      for (const key of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        if (typeof annotations[key] !== "boolean")
          problems.push(`${tool.name} ${key} is ${String(annotations[key])}`);
      }
      if (tool.inputSchema.type !== "object")
        problems.push(`${tool.name} inputSchema type is ${String(tool.inputSchema.type)}`);
      schemaProblems(tool.inputSchema, tool.name, tool.inputSchema, problems);
      if (tool.annotations?.readOnlyHint === true) {
        if (tool.annotations.destructiveHint !== false)
          problems.push(`${tool.name} read is destructive`);
        if (tool.annotations.idempotentHint !== true)
          problems.push(`${tool.name} read is not idempotent`);
        if (tool.annotations.openWorldHint !== false)
          problems.push(`${tool.name} read is open world`);
      }
      if (/^(delete_|cancel_)/.test(tool.name) && tool.annotations?.destructiveHint !== true)
        problems.push(`${tool.name} is not marked destructive`);
    }
    expect(problems).toEqual([]);

    const blockTool = tools.find((tool) => tool.name === "create_page_block");
    const typeEnum = (blockTool?.inputSchema.properties as { type?: { enum?: string[] } })?.type
      ?.enum;
    expect(typeEnum).not.toEqual(expect.arrayContaining(["commerce", "booking", "tip_jar"]));
    for (const name of [
      "schedule_social_post",
      "create_auto_dm_automation",
      "update_auto_dm_automation",
      "set_auto_dm_enabled",
      "delete_auto_dm_automation",
    ]) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.openWorldHint).toBe(true);
    }
    expect(tools.find((tool) => tool.name === "draft_social_post")?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    });
    expect(tools.find((tool) => tool.name === "cancel_social_post")?.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("keeps read-only tools off write handlers and matches the other annotations", async () => {
    const { calls, operations } = fakeOperations();
    const tools = await listedTools(operations);
    expect(Object.keys(samples).sort()).toEqual(tools.map((tool) => tool.name).sort());
    const handler = chatGptHandler(operations);
    for (const tool of tools) {
      const start = calls.length;
      const response = await handler.fetch(
        rpc("https://mcp.example.com/chatgpt/mcp", 2, "tools/call", {
          name: tool.name,
          arguments: samples[tool.name],
        }),
        { authInfo },
      );
      const body = await payload(response);
      expect(body.error, JSON.stringify(body.error || body.result)).toBeUndefined();
      expect(body.result?.isError, JSON.stringify(body.result)).toBeFalsy();
      const used = calls.slice(start).map((call) => call.name);
      if (tool.annotations?.readOnlyHint === true) {
        expect(
          used.filter((name) => !READ_OPS.has(name)),
          tool.name,
        ).toEqual([]);
      } else {
        expect(
          used.some((name) => WRITE_OPS.has(name)),
          `${tool.name} called ${used.join(",")}`,
        ).toBe(true);
      }
    }

    const saves = calls.filter((call) => call.name === "saveSocialPostForUser");
    expect(saves).toHaveLength(3);
    for (const save of saves) {
      expect(save.args[1]).toMatchObject({ publishNow: false });
    }
    expect(saves.map((save) => (save.args[1] as { asDraft: boolean }).asDraft)).toEqual([
      true,
      false,
      true,
    ]);
    expect(calls.find((call) => call.name === "manageScheduler")?.args[1]).toMatchObject({
      action: "cancel_post",
      id: POST,
    });
    const create = calls.find(
      (call) => call.name === "saveAutoDmAutomation" && !(call.args[2] as { id?: string }).id,
    );
    expect(create?.args[2]).toMatchObject({ enabled: false });
  });

  it("hides commerce records from reads and refuses commerce block edits", async () => {
    const { calls, operations } = fakeOperations();
    const handler = chatGptHandler(operations);
    const call = async (name: string, arguments_: Record<string, unknown>) => {
      const response = await handler.fetch(
        rpc("https://mcp.example.com/chatgpt/mcp", 3, "tools/call", {
          name,
          arguments: arguments_,
        }),
        { authInfo },
      );
      return payload(response);
    };

    const overview = await call("get_bento_overview", {});
    expect(overview.result.structuredContent.overview.counts.products).toBeUndefined();
    expect(overview.result.structuredContent.overview.counts.bookings).toBeUndefined();
    expect(overview.result.structuredContent.overview.features.products).toBeUndefined();
    expect(JSON.stringify(overview.result)).not.toContain("/store");

    const profile = await call("get_profile", {});
    expect(JSON.stringify(profile.result)).not.toContain("paymentAccounts");
    expect(JSON.stringify(profile.result)).not.toContain("stripe");

    const analytics = await call("get_analytics", {});
    expect(analytics.result.structuredContent.analytics.dataAccess).toBeUndefined();
    expect(analytics.result.structuredContent.analytics.site).toEqual({ views: 1 });

    const blocks = await call("list_page_blocks", {});
    expect(
      blocks.result.structuredContent.blocks.map((block: { type: string }) => block.type),
    ).toEqual(["heading"]);

    const calendar = await call("get_content_calendar", {});
    expect(calendar.result.structuredContent.calendar.scheduledPosts).toEqual([
      { id: POST, status: "scheduled", body: "Later" },
    ]);

    const before = calls.filter((entry) => entry.name === "mutateBlock").length;
    const blocked = await call("update_page_block", {
      id: "commerce-block",
      content: { title: "Kit" },
    });
    expect(blocked.result.isError).toBe(true);
    expect(calls.filter((entry) => entry.name === "mutateBlock")).toHaveLength(before);

    const rejected = await call("create_page_block", { type: "commerce" });
    expect(rejected.result.isError).toBe(true);
    expect(calls.filter((entry) => entry.name === "mutateBlock")).toHaveLength(before);
  });

  it("serves ChatGPT OAuth metadata, CORS, and invalid_token without changing /mcp", async () => {
    const previous = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = "https://example.supabase.co";
    try {
      const metadata = await handleBentoMcpRequest(
        new Request("https://mcp.example.com/.well-known/oauth-protected-resource/chatgpt/mcp"),
      );
      expect(metadata?.status).toBe(200);
      await expect(metadata?.json()).resolves.toMatchObject({
        resource: "https://mcp.example.com/chatgpt/mcp",
        authorization_servers: ["https://example.supabase.co/auth/v1"],
        bearer_methods_supported: ["header"],
      });

      const legacy = await handleBentoMcpRequest(
        new Request("https://mcp.example.com/.well-known/oauth-protected-resource"),
      );
      await expect(legacy?.json()).resolves.toMatchObject({
        resource: "https://mcp.example.com/mcp",
      });
    } finally {
      process.env.SUPABASE_URL = previous;
    }

    const denied = await handleBentoMcpRequest(
      rpc("https://mcp.example.com/chatgpt/mcp", 1, "tools/list", {}),
      async () => {
        throw new RequestHttpError(401, "Unauthorized");
      },
    );
    expect(denied?.status).toBe(401);
    const header = denied?.headers.get("www-authenticate") ?? "";
    expect(header).toContain('error="invalid_token"');
    expect(header).toContain(
      'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/chatgpt/mcp"',
    );

    const malformed = await handleBentoMcpRequest(
      new Request("https://mcp.example.com/chatgpt/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer aaaaaaaa.bbbbbbbb.cccccccc",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "probe", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(malformed?.status).toBe(401);
    expect(malformed?.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const blocked = await handleBentoMcpRequest(
      new Request("https://mcp.example.com/chatgpt/mcp", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(blocked?.status).toBe(403);

    const cors = await handleBentoMcpRequest(
      new Request("https://mcp.example.com/chatgpt/mcp", {
        method: "POST",
        headers: {
          origin: "https://chatgpt.com",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${authInfo.token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "chatgpt", version: "1.0.0" },
          },
        }),
      }),
      async () => authInfo,
    );
    expect(cors?.status).toBe(200);
    expect(cors?.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    const initialized = await payload(cors!);
    expect(initialized.result.serverInfo).toMatchObject({ name: "bento", version: "1.1.0" });

    const legacyTools = await handleBentoMcpRequest(
      rpc("https://mcp.example.com/mcp", 1, "tools/list", {}),
      async () => authInfo,
    );
    const legacyBody = await payload(legacyTools!);
    const legacyNames = legacyBody.result.tools.map((tool: { name: string }) => tool.name);
    expect(legacyBody.result.serverInfo).toBeUndefined();
    expect(legacyNames).toEqual(
      expect.arrayContaining([
        "manage_product",
        "manage_discount_code",
        "manage_order_bump",
        "manage_earn",
        "get_store_workspace",
        "list_bookings",
        "create_social_post",
      ]),
    );
    expect(legacyNames).not.toContain("draft_social_post");

    const legacyInitialize = await handleBentoMcpRequest(
      rpc("https://mcp.example.com/mcp", 1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude", version: "1.0.0" },
      }),
      async () => authInfo,
    );
    expect((await payload(legacyInitialize!)).result.serverInfo).toMatchObject({
      name: "bento",
      version: "1.0.0",
    });
  });

  it("matches the submission table to the live tool list", () => {
    return listedTools().then((tools) => {
      const doc = readFileSync(join(process.cwd(), "docs/chatgpt-mcp.md"), "utf8");
      expect(doc).toContain("https://mcp.example.com/chatgpt/mcp");
      const rows = doc
        .split("\n")
        .filter((line) => line.startsWith("| `"))
        .map((line) => line.split("|").map((cell) => cell.trim()));
      expect(rows.map((row) => row[1].replaceAll("`", ""))).toEqual(tools.map((tool) => tool.name));
      for (const [row, tool] of rows.map((cells, index) => [cells, tools[index]] as const)) {
        expect(row[2]).toBe(tool.description);
        expect(row[3]).toBe(String(tool.annotations?.readOnlyHint));
        expect(row[4]).toBe(String(tool.annotations?.destructiveHint));
        expect(row[5]).toBe(String(tool.annotations?.idempotentHint));
        expect(row[6]).toBe(String(tool.annotations?.openWorldHint));
        expect(row[7]?.length).toBeGreaterThan(20);
      }
    });
  });
});

function handleBentoMcpRequest(
  request: Request,
  authenticate?: Parameters<typeof handleInstanceMcpRequest>[2],
) {
  return handleInstanceMcpRequest(request, "https://mcp.example.com", authenticate);
}
