import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { freeTools } from "./mcp-free-text";
import {
  defaultMcpFreeToolOperations,
  listMcpFreeTools,
  registerMcpFreeTools,
} from "./mcp-free-tools.server";

const ownerId = "00000000-0000-4000-8000-000000000001";
const brandId = "00000000-0000-4000-8000-000000000002";
const foreignId = "00000000-0000-4000-8000-000000000003";
const authInfo = {
  token: "test-bearer-token-that-is-long-enough",
  clientId: "test-client",
  scopes: ["openid"],
  extra: { userId: ownerId },
} satisfies AuthInfo;

function registry() {
  const tools = new Map<
    string,
    {
      execute: (input: unknown) => Promise<unknown>;
      inputSchema: { parse: (input: unknown) => unknown };
    }
  >();
  const server = {
    registerTool(
      name: string,
      config: { inputSchema: { parse: (input: unknown) => unknown } },
      callback: (input: never) => Promise<unknown>,
    ) {
      tools.set(name, {
        inputSchema: config.inputSchema,
        execute: async (input) => callback(config.inputSchema.parse(input) as never),
      });
    },
  } as unknown as Pick<McpServer, "registerTool">;
  return { server, tools };
}

describe("Bento MCP free tool catalog", () => {
  it("maps every public free tool to a runnable MCP operation", () => {
    const listed = listMcpFreeTools();
    expect(listed).toHaveLength(59);
    expect(listed.map((tool) => tool.slug).sort()).toEqual(
      freeTools.map((tool) => tool.slug).sort(),
    );
    expect(
      Object.fromEntries(
        [
          "run_free_text_tool",
          "run_free_ai_tool",
          "run_free_media_tool",
          "run_free_image_tool",
          "transcribe_free_audio",
        ].map((name) => [name, listed.filter((tool) => tool.runWith === name).length]),
      ),
    ).toEqual({
      run_free_text_tool: 9,
      run_free_ai_tool: 29,
      run_free_media_tool: 15,
      run_free_image_tool: 5,
      transcribe_free_audio: 1,
    });
    expect(listed.every((tool) => tool.inputHints.length && tool.url.endsWith(tool.slug))).toBe(
      true,
    );
  });

  it("checks workspace ownership before an AI provider can run", async () => {
    const { server, tools } = registry();
    const runMcpFreeAiTool = vi.fn(async () => ({
      outputs: ["A caption"],
      provider: "workers-ai" as const,
    }));
    const resolveMcpWorkspaceId = vi.fn(async (_authUserId: string, requestedId?: string) => {
      if (requestedId === foreignId) throw new Error("Workspace is unavailable.");
      return requestedId ?? ownerId;
    });
    registerMcpFreeTools(server, authInfo, {
      ...defaultMcpFreeToolOperations,
      resolveMcpWorkspaceId,
      runMcpFreeAiTool,
    });
    const tool = tools.get("run_free_ai_tool")!;
    await expect(
      tool.execute({
        workspaceId: foreignId,
        toolSlug: "instagram-bio-generator",
        platform: "Instagram",
        values: { role: "Creator" },
      }),
    ).rejects.toThrow("Workspace is unavailable");
    expect(runMcpFreeAiTool).not.toHaveBeenCalled();

    await tool.execute({
      workspaceId: brandId,
      toolSlug: "instagram-bio-generator",
      platform: "Instagram",
      values: { role: "Creator" },
    });
    expect(resolveMcpWorkspaceId).toHaveBeenCalledWith(ownerId, brandId);
    expect(runMcpFreeAiTool).toHaveBeenCalledWith(brandId, {
      toolSlug: "instagram-bio-generator",
      platform: "Instagram",
      values: { role: "Creator" },
    });
  });

  it("requires media rights and returns transformed images without duplicating base64", async () => {
    const { server, tools } = registry();
    const runMcpFreeMediaTool = vi.fn(async () => ({ kind: "download", items: [] }));
    const runMcpFreeImageTool = vi.fn(async () => ({
      toolSlug: "image-compressor" as const,
      images: [
        {
          name: "a.webp",
          mimeType: "image/webp" as const,
          width: 1,
          height: 1,
          bytes: 3,
          base64: "AQID",
        },
      ],
    }));
    registerMcpFreeTools(server, authInfo, {
      ...defaultMcpFreeToolOperations,
      resolveMcpWorkspaceId: async (authUserId) => authUserId,
      runMcpFreeMediaTool,
      runMcpFreeImageTool,
    });
    const media = tools.get("run_free_media_tool")!;
    await expect(
      media.execute({
        toolSlug: "youtube-video-downloader",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        rightsConfirmed: false,
      }),
    ).rejects.toThrow();
    expect(runMcpFreeMediaTool).not.toHaveBeenCalled();

    const image = (await tools.get("run_free_image_tool")!.execute({
      toolSlug: "image-compressor",
      fileName: "a.png",
      mimeType: "image/png",
      base64: "AQID",
    })) as { content: Array<{ type: string; data?: string }>; structuredContent: unknown };
    expect(image.content[1]).toMatchObject({ type: "image", data: "AQID" });
    expect(JSON.stringify(image.structuredContent)).not.toContain("AQID");
  });
});
