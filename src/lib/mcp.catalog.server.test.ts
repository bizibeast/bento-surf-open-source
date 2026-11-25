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

vi.mock("./external-tools.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./external-tools.server")>()),
  externalToolsEnabled: () => true,
}));
vi.mock("./granola-mcp-gateway.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./granola-mcp-gateway.server")>()),
  granolaGatewayEnabled: () => true,
}));

import { createBentoMcpServer, createChatGptMcpServer } from "./mcp.server";

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
  it("serves neutral tool and parameter descriptions in both catalogs", async () => {
    vi.stubEnv("BENTO_V2_REFERENCE_ANALYSIS_ENABLED", "true");
    vi.stubEnv("BENTO_V2_STUDIO_ENABLED", "true");
    vi.stubEnv("BENTO_V2_CREATOR_INTELLIGENCE_ENABLED", "true");
    try {
      for (const factory of [createBentoMcpServer, createChatGptMcpServer]) {
        const handler = createMcpHandler(() => factory(authInfo, "http://localhost:8080"));
        const response = await handler.fetch(rpc(1, "tools/list", {}), { authInfo });
        const tools = (await payload(response)).result.tools as Array<{
          name: string;
          description?: string;
          inputSchema: unknown;
          annotations?: Record<string, unknown>;
        }>;
        expect(tools.length).toBeGreaterThan(10);
        const names = tools.map(({ name }) => name);
        expect(names.filter((name) => /heygen|earn/.test(name))).toEqual([]);
        const referenceNames = [
          "analyze_content_reference",
          "create_video_frame_grid",
          "get_content_reference",
          "create_content_from_reference",
        ];
        for (const name of referenceNames) {
          if (factory === createBentoMcpServer) expect(names).toContain(name);
          else expect(names).not.toContain(name);
        }
        if (factory === createChatGptMcpServer) {
          expect(names).toContain("transcribe_free_audio");
          expect(
            names.filter((name) =>
              /^(list_free_tools|run_free_.*|.*content_studio.*|.*reel_production.*|list_reel_avatars|list_reel_voices)$/.test(
                name,
              ),
            ),
          ).toEqual([]);
        }
        if (factory === createBentoMcpServer) {
          for (const name of [
            "list_reel_avatars",
            "list_reel_voices",
            "prepare_reel_production",
            "manage_content_agent",
          ]) {
            expect(names).not.toContain(name);
          }
          expect(names).toContain("get_content_agent");
          expect(names).toContain("get_reel_production");
        }
        for (const tool of tools) {
          expect(tool.annotations?.title, tool.name).toBeTruthy();
          for (const hint of [
            "readOnlyHint",
            "destructiveHint",
            "openWorldHint",
            "idempotentHint",
          ]) {
            expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
          }
        }

        const problems: string[] = [];
        function check(description: string, owner: string, path: string) {
          if (/\b(?:must|never|always|do not|don't)\b/i.test(description))
            problems.push(`${path}: steering`);
          if (
            /(?:^|[.\n])\s*(?:use|prefer|never|always|must|should|do not|don't|call)\b/i.test(
              description,
            )
          )
            problems.push(`${path}: imperative`);
          if (
            /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(
              description,
            )
          )
            problems.push(`${path}: invisible character`);
          if (/(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{48,}={0,2}(?:$|[^A-Za-z0-9+/])/.test(description))
            problems.push(`${path}: encoded text`);
          if (
            /skill:\/\/|<!--|\b(?:see|read|follow) (?:the )?(?:docs|documentation|skill|server instructions)\b/i.test(
              description,
            )
          )
            problems.push(`${path}: external or hidden text`);
          for (const { name } of tools) {
            if (
              name !== owner &&
              new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(description)
            )
              problems.push(`${path}: references ${name}`);
          }
        }
        function scan(value: unknown, owner: string, path: string) {
          if (Array.isArray(value))
            return value.forEach((item, i) => scan(item, owner, `${path}[${i}]`));
          if (!isRecord(value)) return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "description" && typeof child === "string")
              check(child, owner, `${path}.${key}`);
            else if (key !== "annotations") scan(child, owner, `${path}.${key}`);
          }
        }
        for (const tool of tools) {
          if (tool.description) check(tool.description, tool.name, tool.name);
          scan(tool.inputSchema, tool.name, `${tool.name}.inputSchema`);
        }
        if (factory === createBentoMcpServer) {
          const resourceResponse = await handler.fetch(rpc(2, "resources/list", {}), { authInfo });
          const resources = (await payload(resourceResponse)).result.resources as Array<{
            name: string;
            description?: string;
          }>;
          expect(resources).toHaveLength(16);
          for (const resource of resources) {
            if (resource.description)
              check(resource.description, resource.name, `resource.${resource.name}`);
          }
        }
        expect(problems).toEqual([]);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
