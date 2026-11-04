import { configuredAppOrigin } from "./application-urls";
import { Buffer } from "node:buffer";
import { handleBackgroundRemovalRequest } from "./background-removal-tool.server";
import { socialImagePresets } from "./free-image-tools";
import { readMcpFreeFile, type McpFreeFileInput } from "./mcp-free-files.server";
import { reserveProviderUsage, withProviderBudgetWorkspace } from "./provider-budget.server";
import { readResponseBytes } from "./request-security.server";

export const imageFreeToolSlugs = [
  "social-image-resizer",
  "image-compressor",
  "image-flipper",
  "image-splitter",
  "background-remover",
] as const;

export type McpFreeImageInput = McpFreeFileInput & {
  toolSlug: (typeof imageFreeToolSlugs)[number];
  presetId?: (typeof socialImagePresets)[number]["id"];
  fit?: "cover" | "contain";
  background?: string;
  quality?: number;
  flipAxis?: "horizontal" | "vertical";
  parts?: 2 | 3;
};

export type McpFreeImageOutput = {
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  bytes: number;
  base64: string;
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 30_000_000;

type ImageEnv = {
  APP_ENV?: string;
  IMAGES?: ImagesBinding;
  FREE_TOOLS_MEDIA_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
};

function imageStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function safeBaseName(name: string) {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "bento-image"
  );
}

async function readImageOutput(
  response: Response,
  name: string,
  mimeType: McpFreeImageOutput["mimeType"],
  width: number,
  height: number,
): Promise<McpFreeImageOutput> {
  if (!response.ok) throw new Error("The image transformation failed.");
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytes(response, MAX_OUTPUT_BYTES);
  } catch {
    throw new Error("The image result is too large for MCP. Try a smaller image.");
  }
  if (!bytes.length) throw new Error("The image transformation returned an empty result.");
  return {
    name,
    mimeType,
    width,
    height,
    bytes: bytes.length,
    base64: Buffer.from(bytes).toString("base64"),
  };
}

async function enforceImageRateLimit(workspaceId: string, env: ImageEnv) {
  const limiter = env.FREE_TOOLS_MEDIA_RATE_LIMITER;
  if (!limiter) {
    if (env.APP_ENV === "production" || env.APP_ENV === "staging")
      throw new Error("Image tools are temporarily unavailable.");
    return;
  }
  const result = await limiter.limit({ key: `free-tool-image:mcp:${workspaceId}`.slice(0, 512) });
  if (!result.success) throw new Error("Too many image requests. Please wait a minute.");
}

export async function runMcpFreeImageTool(
  workspaceId: string,
  input: McpFreeImageInput,
  env: ImageEnv = (globalThis.__env__ ?? {}) as ImageEnv,
): Promise<{ toolSlug: McpFreeImageInput["toolSlug"]; images: McpFreeImageOutput[] }> {
  if (!imageFreeToolSlugs.includes(input.toolSlug)) throw new Error("Choose an image tool.");
  if (!env.IMAGES) throw new Error("Image tools are temporarily unavailable.");
  const images = env.IMAGES;
  if (input.toolSlug !== "background-remover") await enforceImageRateLimit(workspaceId, env);

  const file = await readMcpFreeFile(workspaceId, input, MAX_IMAGE_BYTES);
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimeType.toLowerCase()))
    throw new Error("Use a JPG, PNG, or WebP image.");
  const info = await images.info(imageStream(file.bytes));
  if (
    !("width" in info) ||
    !["image/jpeg", "image/png", "image/webp", "jpeg", "png", "webp"].includes(
      info.format.toLowerCase(),
    ) ||
    info.width <= 0 ||
    info.height <= 0 ||
    info.width * info.height > MAX_PIXELS
  )
    throw new Error("Use a supported image under 30 megapixels.");

  const base = safeBaseName(file.fileName);
  const width = info.width;
  const height = info.height;
  return withProviderBudgetWorkspace(workspaceId, async () => {
    if (input.toolSlug === "background-remover") {
      const response = await handleBackgroundRemovalRequest(
        new Request(`${configuredAppOrigin(process.env.VITE_APP_URL)}/api/tools/remove-background`, {
          method: "POST",
          headers: {
            origin: configuredAppOrigin(process.env.VITE_APP_URL),
            "content-type": file.mimeType,
            "x-bento-file-size": String(file.bytes.length),
          },
          body: file.bytes as Uint8Array<ArrayBuffer>,
        }),
        env,
        { trustedMcpWorkspaceId: workspaceId },
      );
      if (!response?.ok) {
        const payload = (await response?.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "The image background could not be removed.");
      }
      return {
        toolSlug: input.toolSlug,
        images: [
          await readImageOutput(
            response,
            `${base}-background-removed.png`,
            "image/png",
            width,
            height,
          ),
        ],
      };
    }

    const quality = input.quality ?? 76;
    if (!Number.isInteger(quality) || quality < 35 || quality > 95)
      throw new Error("Choose export quality between 35 and 95.");
    const background = input.background ?? "#ffffff";
    if (!/^#[\da-f]{6}$/iu.test(background))
      throw new Error("Use a six-digit hex background color.");
    const outputs: McpFreeImageOutput[] = [];

    if (input.toolSlug === "social-image-resizer") {
      const preset = socialImagePresets.find(
        (item) => item.id === (input.presetId ?? "instagram-square"),
      );
      if (!preset) throw new Error("Choose a supported social image preset.");
      const fit = input.fit ?? "cover";
      if (fit !== "cover" && fit !== "contain") throw new Error("Choose cover or contain fit.");
      await reserveProviderUsage("image_transformations", 1, { workspaceId });
      const result = await images
        .input(imageStream(file.bytes))
        .transform({
          width: preset.width,
          height: preset.height,
          fit: fit === "contain" ? "pad" : "cover",
          background,
        })
        .output({ format: "image/jpeg", quality });
      outputs.push(
        await readImageOutput(
          result.response(),
          `${base}-${preset.id}.jpg`,
          "image/jpeg",
          preset.width,
          preset.height,
        ),
      );
    } else if (input.toolSlug === "image-compressor") {
      await reserveProviderUsage("image_transformations", 1, { workspaceId });
      const result = await images
        .input(imageStream(file.bytes))
        .output({ format: "image/webp", quality });
      outputs.push(
        await readImageOutput(
          result.response(),
          `${base}-compressed.webp`,
          "image/webp",
          width,
          height,
        ),
      );
    } else if (input.toolSlug === "image-flipper") {
      const axis = input.flipAxis ?? "horizontal";
      if (axis !== "horizontal" && axis !== "vertical") throw new Error("Choose a flip direction.");
      await reserveProviderUsage("image_transformations", 1, { workspaceId });
      const result = await images
        .input(imageStream(file.bytes))
        .transform({ flip: axis === "horizontal" ? "h" : "v" })
        .output({ format: "image/png" });
      outputs.push(
        await readImageOutput(result.response(), `${base}-flipped.png`, "image/png", width, height),
      );
    } else {
      const parts = input.parts ?? 3;
      if (parts !== 2 && parts !== 3) throw new Error("Choose two or three image tiles.");
      await reserveProviderUsage("image_transformations", parts, { workspaceId });
      const tileWidth = Math.floor(width / parts);
      if (tileWidth < 1) throw new Error("This image is too narrow to split.");
      for (let index = 0; index < parts; index += 1) {
        const left = index * tileWidth;
        const targetWidth = index === parts - 1 ? width - left : tileWidth;
        const result = await images
          .input(imageStream(file.bytes))
          .transform({
            width: targetWidth,
            height,
            fit: "crop",
            gravity: { x: (left + targetWidth / 2) / width, y: 0.5, mode: "box-center" },
          })
          .output({ format: "image/png" });
        outputs.push(
          await readImageOutput(
            result.response(),
            `${base}-${index + 1}-of-${parts}.png`,
            "image/png",
            targetWidth,
            height,
          ),
        );
      }
    }
    if (outputs.reduce((total, item) => total + item.bytes, 0) > MAX_RESULT_BYTES)
      throw new Error("The image results are too large for MCP. Try a smaller image.");
    return { toolSlug: input.toolSlug, images: outputs };
  });
}
