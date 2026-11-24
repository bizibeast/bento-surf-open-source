import { freeTools, freeToolPlatforms, isAiFreeToolKind } from "./free-tools";
import { socialImagePresets } from "./free-image-tools";
import { parseFreeToolContentInput, runFreeToolAiProvider } from "./free-tools.functions";
import { runDeterministicFreeTool, type DeterministicFreeToolInput } from "./mcp-free-text";
import { runMcpFreeImageTool, type McpFreeImageInput } from "./mcp-free-image.server";
import { readMcpFreeFile, type McpFreeFileInput } from "./mcp-free-files.server";
import { handleFreeToolMediaRequest, type MediaToolsEnv } from "./media-tools.server";
import { MEDIA_TOOLS_API_PATH, type MediaToolRequest } from "./media-tools";
import { withProviderBudgetWorkspace } from "./provider-budget.server";
import { enforceRequestRateLimit } from "./request-security.server";
import {
  handleFreeToolTranscriptionRequest,
  type TranscriptionEnv,
} from "./transcription-tool.server";
import { MAX_TRANSCRIPTION_BYTES, TRANSCRIPTION_API_PATH } from "./transcription-tool";
import { imageFreeToolSlugs } from "./mcp-free-image.server";
import { deterministicFreeToolSlugs } from "./mcp-free-text";
import { mediaToolSpecsBySlug, mediaDownloadQualities } from "./media-tools";
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod-v4";

export function listMcpFreeTools() {
  return freeTools.map((tool) => {
    const runWith = isAiFreeToolKind(tool.kind)
      ? "run_free_ai_tool"
      : ["utm", "counter", "formatter", "line-breaker", "unicode", "thread-splitter"].includes(
            tool.kind,
          )
        ? "run_free_text_tool"
        : tool.kind === "transcript"
          ? "transcribe_free_audio"
          : [
                "image-resizer",
                "image-compressor",
                "image-flipper",
                "image-splitter",
                "background-remover",
              ].includes(tool.kind)
            ? "run_free_image_tool"
            : "run_free_media_tool";
    const inputHints =
      runWith === "run_free_ai_tool"
        ? ["platform", "values", ...(tool.fields ?? []).map((field) => `values.${field.key}`)]
        : runWith === "run_free_media_tool"
          ? [
              "url",
              "rightsConfirmed",
              ...(tool.kind === "video-downloader" ? ["quality (optional)"] : []),
            ]
          : runWith === "run_free_image_tool"
            ? ["fileName", "base64 or mediaKey", "mimeType for base64", "mode options as needed"]
            : runWith === "transcribe_free_audio"
              ? ["fileName", "base64 or mediaKey", "mimeType for base64"]
              : tool.kind === "utm"
                ? ["url", "source", "campaign", "medium/term/content (optional)"]
                : ["text", ...(tool.kind === "counter" ? ["platform (optional)"] : [])];
    return {
      slug: tool.slug,
      name: tool.name,
      category: tool.category,
      kind: tool.kind,
      description: tool.description,
      url: `${process.env.VITE_APP_URL || "http://localhost:8080"}/mcp#${tool.slug}`,
      ...(tool.fixedPlatform ? { fixedPlatform: tool.fixedPlatform } : {}),
      ...(tool.counterLimit ? { counterLimit: tool.counterLimit } : {}),
      ...(tool.fields ? { fields: tool.fields } : {}),
      runWith,
      inputHints,
    };
  });
}

export function runMcpFreeTextTool(input: DeterministicFreeToolInput) {
  return runDeterministicFreeTool(input);
}

export async function runMcpFreeAiTool(workspaceId: string, raw: unknown) {
  const input = parseFreeToolContentInput(raw);
  await enforceRequestRateLimit("FREE_TOOLS_AI_RATE_LIMITER", "mcp-free-tools-ai", workspaceId);
  return withProviderBudgetWorkspace(workspaceId, () =>
    runFreeToolAiProvider(
      input,
      (globalThis.__env__ ?? {}) as Parameters<typeof runFreeToolAiProvider>[1],
    ),
  );
}

async function responseData(response: Response | null, fallback: string) {
  if (!response) throw new Error(fallback);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : fallback);
  if (!data) throw new Error(fallback);
  return data;
}

export async function runMcpFreeMediaTool(
  workspaceId: string,
  input: MediaToolRequest & { rightsConfirmed: true },
) {
  if (input.rightsConfirmed !== true)
    throw new Error("Confirm ownership or permission to use this public media first.");
  const request = new Request(
    `${process.env.VITE_APP_URL || "http://localhost:8080"}${MEDIA_TOOLS_API_PATH}`,
    {
      method: "POST",
      headers: {
        origin: process.env.VITE_APP_URL || "http://localhost:8080",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        toolSlug: input.toolSlug,
        url: input.url,
        ...(input.quality ? { quality: input.quality } : {}),
      }),
    },
  );
  return withProviderBudgetWorkspace(workspaceId, async () =>
    responseData(
      await handleFreeToolMediaRequest(request, (globalThis.__env__ ?? {}) as MediaToolsEnv, {
        trustedMcpWorkspaceId: workspaceId,
      }),
      "The media tool could not complete this request.",
    ),
  );
}

export type McpFreeAudioInput = McpFreeFileInput;

export async function transcribeMcpFreeAudio(workspaceId: string, input: McpFreeAudioInput) {
  const file = await readMcpFreeFile(workspaceId, input, MAX_TRANSCRIPTION_BYTES);
  const request = new Request(
    `${process.env.VITE_APP_URL || "http://localhost:8080"}${TRANSCRIPTION_API_PATH}`,
    {
      method: "POST",
      headers: {
        origin: process.env.VITE_APP_URL || "http://localhost:8080",
        "content-type": file.mimeType,
        "x-bento-file-size": String(file.bytes.length),
      },
      body: file.bytes as Uint8Array<ArrayBuffer>,
    },
  );
  return withProviderBudgetWorkspace(workspaceId, async () =>
    responseData(
      await handleFreeToolTranscriptionRequest(
        request,
        (globalThis.__env__ ?? {}) as TranscriptionEnv,
        { trustedMcpWorkspaceId: workspaceId },
      ),
      "The audio could not be transcribed.",
    ),
  );
}

export { runMcpFreeImageTool };
export type { McpFreeImageInput };

export const defaultMcpFreeToolOperations = {
  listMcpFreeTools,
  runMcpFreeTextTool,
  runMcpFreeAiTool,
  runMcpFreeMediaTool,
  runMcpFreeImageTool,
  transcribeMcpFreeAudio,
};

export type McpFreeToolOperations = typeof defaultMcpFreeToolOperations & {
  resolveMcpWorkspaceId: (authUserId: string, requestedId?: string) => Promise<string>;
};

const aiSlugs = freeTools
  .filter((tool) => isAiFreeToolKind(tool.kind))
  .map((tool) => tool.slug) as [string, ...string[]];
const mediaSlugs = Object.keys(mediaToolSpecsBySlug) as [string, ...string[]];
const imagePresets = socialImagePresets.map((preset) => preset.id) as [string, ...string[]];

function result(message: string, data: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: message },
      { type: "text" as const, text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}

export function registerMcpFreeTools(
  server: Pick<McpServer, "registerTool">,
  authInfo: AuthInfo,
  operations: McpFreeToolOperations,
) {
  const authUserId = authInfo.extra?.userId;
  if (typeof authUserId !== "string") throw new Error("Bento authorization is missing.");
  const workspace = (workspaceId?: string) =>
    operations.resolveMcpWorkspaceId(authUserId, workspaceId);

  server.registerTool(
    "list_free_tools",
    {
      title: "List Bento free tools",
      description:
        "List runnable Bento free tools, their slugs, required fields, and runners. No provider request is made.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result("Loaded Bento free tools.", { tools: await operations.listMcpFreeTools() }),
  );

  server.registerTool(
    "run_free_text_tool",
    {
      title: "Run a free text or link tool",
      description:
        "Run Bento's UTM builder, character counters, formatters, Unicode styler, or thread splitter.",
      inputSchema: z.object({
        workspaceId: z.uuid().optional(),
        toolSlug: z.enum(deterministicFreeToolSlugs),
        text: z.string().max(50_000).optional(),
        platform: z.enum(freeToolPlatforms).optional(),
        style: z.enum(["bold", "italic", "bold-italic", "normal"]).optional(),
        numbered: z.boolean().optional(),
        url: z.string().max(2_048).optional(),
        source: z.string().max(200).optional(),
        medium: z.string().max(200).optional(),
        campaign: z.string().max(200).optional(),
        term: z.string().max(200).optional(),
        content: z.string().max(200).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspaceId, ...input }) => {
      const selectedId = await workspace(workspaceId);
      return result("Ran the Bento text tool.", {
        workspaceId: selectedId,
        output: await operations.runMcpFreeTextTool(input),
      });
    },
  );

  server.registerTool(
    "run_free_ai_tool",
    {
      title: "Run a free AI writing tool",
      description:
        "Run one of Bento's 29 free AI writing tools. Accepts a slug, platform, and tool-specific fields. Uses the existing free-tool AI budget and one bounded provider attempt.",
      inputSchema: z.object({
        workspaceId: z.uuid().optional(),
        toolSlug: z.enum(aiSlugs),
        platform: z.enum(freeToolPlatforms),
        values: z
          .record(z.string().max(40), z.string().max(12_000))
          .refine((values) => Object.keys(values).length <= 20, "Use at most 20 fields."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, ...input }) => {
      const selectedId = await workspace(workspaceId);
      return result("Generated Bento free-tool content.", {
        workspaceId: selectedId,
        toolSlug: input.toolSlug,
        ...(await operations.runMcpFreeAiTool(selectedId, input)),
      });
    },
  );

  server.registerTool(
    "run_free_media_tool",
    {
      title: "Run a public media free tool",
      description:
        "Resolve a public YouTube, Instagram, TikTok, X, Pinterest, or LinkedIn video, image, cover, carousel, or URL transcript. Download URLs expire quickly. No private or login-only media.",
      inputSchema: z.object({
        workspaceId: z.uuid().optional(),
        toolSlug: z.enum(mediaSlugs),
        url: z.string().url().max(2_048),
        quality: z.enum(mediaDownloadQualities).optional(),
        rightsConfirmed: z.literal(true),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, ...input }) => {
      const selectedId = await workspace(workspaceId);
      return result("Ran the Bento public media tool.", {
        workspaceId: selectedId,
        toolSlug: input.toolSlug,
        output: await operations.runMcpFreeMediaTool(
          selectedId,
          input as Parameters<typeof runMcpFreeMediaTool>[1],
        ),
      });
    },
  );

  server.registerTool(
    "run_free_image_tool",
    {
      title: "Run a free image tool",
      description:
        "Resize, compress, flip, split, or remove an image background. Accepts base64 or a mediaKey owned by the selected workspace. Outputs are returned as MCP images, with no file stored by this tool. Input up to 20 MB; output up to 8 MB total.",
      inputSchema: z.object({
        workspaceId: z.uuid().optional(),
        toolSlug: z.enum(imageFreeToolSlugs),
        fileName: z.string().min(1).max(255),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
        base64: z.string().max(28_000_000).optional(),
        mediaKey: z.string().max(1_024).optional(),
        presetId: z.enum(imagePresets).optional(),
        fit: z.enum(["cover", "contain"]).optional(),
        background: z
          .string()
          .regex(/^#[\da-f]{6}$/iu)
          .optional(),
        quality: z.number().int().min(35).max(95).optional(),
        flipAxis: z.enum(["horizontal", "vertical"]).optional(),
        parts: z.union([z.literal(2), z.literal(3)]).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, ...input }) => {
      const selectedId = await workspace(workspaceId);
      const output = await operations.runMcpFreeImageTool(selectedId, input as McpFreeImageInput);
      return {
        content: [
          {
            type: "text" as const,
            text: `Created ${output.images.length} image result(s) with ${input.toolSlug}.`,
          },
          ...output.images.map((image) => ({
            type: "image" as const,
            data: image.base64,
            mimeType: image.mimeType,
          })),
        ],
        structuredContent: {
          workspaceId: selectedId,
          toolSlug: input.toolSlug,
          images: output.images.map(({ base64: _base64, ...metadata }) => metadata),
        },
      };
    },
  );

  registerMcpFreeAudioTranscription(server, authInfo, operations);
}

export function registerMcpFreeAudioTranscription(
  server: Pick<McpServer, "registerTool">,
  authInfo: AuthInfo,
  operations: McpFreeToolOperations,
) {
  const authUserId = authInfo.extra?.userId;
  if (typeof authUserId !== "string") throw new Error("Bento authorization is missing.");
  const workspace = (workspaceId?: string) =>
    operations.resolveMcpWorkspaceId(authUserId, workspaceId);

  server.registerTool(
    "transcribe_free_audio",
    {
      title: "Transcribe an audio file",
      description:
        "Transcribe an owned Bento audio mediaKey or inline base64 audio up to 12 MB. Returns text and timestamped segments. Uses the existing transcription cap; no file or transcript is stored.",
      inputSchema: z.object({
        workspaceId: z.uuid().optional(),
        fileName: z.string().min(1).max(255),
        mimeType: z.string().max(100).optional(),
        base64: z.string().max(17_000_000).optional(),
        mediaKey: z.string().max(1_024).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspaceId, ...input }) => {
      const selectedId = await workspace(workspaceId);
      return result("Transcribed the audio file.", {
        workspaceId: selectedId,
        output: await operations.transcribeMcpFreeAudio(selectedId, input),
      });
    },
  );
}
