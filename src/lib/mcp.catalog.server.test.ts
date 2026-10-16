import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

import { createBentoMcpServer } from "./mcp.server";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_PUBLISHABLE_KEY ||= "test-publishable-key";

const authInfo: AuthInfo = {
  token: "test-bearer-token-that-is-long-enough",
  clientId: "test-client",
  scopes: ["openid", "email", "profile"],
  extra: { userId: "00000000-0000-4000-8000-000000000001" },
};

const STANDARD_CAPABILITIES = new Set([
  "completions",
  "experimental",
  "logging",
  "prompts",
  "resources",
  "tools",
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
    if (resolvePointer(root, schema.$ref) === undefined) {
      problems.push(`${path} has unresolved $ref ${schema.$ref}`);
    }
  } else if (![...TYPE_KEYS].some((key) => key in schema)) {
    problems.push(`${path} has no explicit type`);
  }
  if (typeof schema.pattern === "string" && schema.pattern.length > 120) {
    problems.push(`${path} pattern is ${schema.pattern.length} characters`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref") continue;
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        schemaProblems(child, `${path}.${key}.${childKey}`, root, problems);
      }
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      value.forEach((item, index) =>
        schemaProblems(item, `${path}.${key}[${index}]`, root, problems),
      );
    } else if (SCHEMA_CHILD_KEYS.has(key)) {
      schemaProblems(value, `${path}.${key}`, root, problems);
    }
  }
}

function countKeyword(value: unknown, keyword: string): number {
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + countKeyword(item, keyword), 0);
  if (!isRecord(value)) return 0;
  return (
    (keyword in value ? 1 : 0) +
    Object.values(value).reduce((sum: number, item) => sum + countKeyword(item, keyword), 0)
  );
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

function rpc(id: number | string | null, method: string, params: unknown, protocol = "2025-06-18") {
  return new Request("http://localhost:8080/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocol,
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  });
}

describe("production MCP catalog", () => {
  it("serves a strict-client initialize and tools/list", async () => {
    const handler = createMcpHandler(() => createBentoMcpServer(authInfo, "http://localhost:8080"));
    const initializeResponse = await handler.fetch(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openai-scanner", version: "1.0.0" },
      }),
      { authInfo },
    );
    expect(initializeResponse.status).toBe(200);
    const initialize = await payload(initializeResponse);
    expect(initialize.result.protocolVersion).toBe("2025-06-18");
    expect(initialize.result.capabilities.extensions).toBeUndefined();
    expect(Object.keys(initialize.result.capabilities).sort()).toEqual(
      Object.keys(initialize.result.capabilities)
        .filter((key) => STANDARD_CAPABILITIES.has(key))
        .sort(),
    );

    const initializedResponse = await handler.fetch(rpc(null, "notifications/initialized", {}), {
      authInfo,
    });
    expect([200, 202]).toContain(initializedResponse.status);

    const toolsResponse = await handler.fetch(rpc(2, "tools/list", {}), { authInfo });
    expect(toolsResponse.status).toBe(200);
    const toolsList = await payload(toolsResponse);
    const tools = toolsList.result.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(10);

    const problems: string[] = [];
    for (const tool of tools) {
      if (tool.inputSchema.type !== "object") {
        problems.push(`${tool.name} inputSchema type is ${String(tool.inputSchema.type)}`);
      }
      schemaProblems(tool.inputSchema, tool.name, tool.inputSchema, problems);
    }
    expect(problems).toEqual([]);

    const toolsJson = JSON.stringify(toolsList);
    expect(toolsJson.length).toBeLessThan(1_500_000);

    const extensionResponse = await handler.fetch(
      rpc(3, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { extensions: { "io.modelcontextprotocol/skills": {} } },
        clientInfo: { name: "openai-skills", version: "1.0.0" },
      }),
      { authInfo },
    );
    const extensionInitialize = await payload(extensionResponse);
    expect(extensionInitialize.result.capabilities.extensions).toEqual({
      "io.modelcontextprotocol/skills": {},
    });
    const skillsResponse = await handler.fetch(rpc(4, "skills/list", {}), { authInfo });
    expect(skillsResponse.status).toBe(200);
    const skillsList = await payload(skillsResponse);
    expect(skillsList.result.skills[0]).toMatchObject({
      uri: "skill://bento/bento/SKILL.md",
      frontmatter: { name: "bento" },
    });

    const artifact = {
      strictClient: {
        initialize,
        notificationsInitialized: { status: initializedResponse.status },
        toolsList,
      },
      extensionClient: { initialize: extensionInitialize, skillsList },
      summary: {
        protocolVersion: initialize.result.protocolVersion,
        strictCapabilities: Object.keys(initialize.result.capabilities).sort(),
        toolCount: names.length,
        toolsListBytes: toolsJson.length,
        duplicateNames: names.length - new Set(names).size,
        maxPatternLength: maxPattern(toolsList),
        oneOfCount: countKeyword(toolsList, "oneOf"),
        anyOfCount: countKeyword(toolsList, "anyOf"),
        refCount: countKeyword(toolsList, "$ref"),
        schemaCount: countKeyword(toolsList, "$schema"),
        extensionsOnStrictClient: initialize.result.capabilities.extensions ?? null,
        extensionsWhenClientOptsIn: extensionInitialize.result.capabilities.extensions,
      },
    };
    const artifactDirectory =
      process.env.BENTO_MCP_CATALOG_ARTIFACT_DIR || join(tmpdir(), "bento-mcp-catalog");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "mcp-initialize-tools-list.json"),
      JSON.stringify(artifact, null, 2),
    );
  });
});

function maxPattern(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, maxPattern(item)), 0);
  if (!isRecord(value)) return 0;
  const own = typeof value.pattern === "string" ? value.pattern.length : 0;
  return Object.values(value).reduce((max: number, item) => Math.max(max, maxPattern(item)), own);
}
