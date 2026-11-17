import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { StudioReel } from "./content-studio";
import { readHeyGenJob } from "./external-tools.server";
import { reserveManagedProviderUsage, settleProviderUsage } from "./provider-budget.server";
import { validateMediaObjectKey } from "./r2-storage.server";
import { readResponseBytes } from "./request-security.server";
import {
  STUDIO_REEL_IMAGE_TYPES,
  STUDIO_REEL_INPUT_LIMIT,
  STUDIO_REEL_OUTPUT_LIMIT,
  STUDIO_REEL_TIMEOUT_MS,
  STUDIO_REEL_VIDEO_TYPES,
  type StudioReelRequest,
} from "./studio-reel-host";
import { resolveWorkspace } from "./workspace-session.server";

const decoder = new TextDecoder();
const assetSchema = z.object({
  id: z.uuid(),
  storage_key: z.string(),
  media_type: z.enum(["image", "video"]),
});

function configuration() {
  const endpoint = process.env.STUDIO_REEL_RENDERER_URL;
  const token = process.env.STUDIO_REEL_RENDERER_TOKEN || "";
  const cost = Number(process.env.STUDIO_REEL_ATTEMPT_MICROUSD);
  if (
    process.env.BENTO_V2_STUDIO_SERVER_REELS !== "true" ||
    !endpoint ||
    !URL.canParse(endpoint) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(token) ||
    !Number.isSafeInteger(cost) ||
    cost < 5_000 ||
    cost > 1_000_000
  )
    return null;
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/render"
  )
    return null;
  return { url, token, cost };
}

export function hostedStudioReelAttemptCost() {
  return configuration()?.cost ?? null;
}

export async function renderStudioReelOnHost(input: {
  bucket: R2Bucket;
  workspaceId: string;
  authUserId: string;
  document: StudioReel;
  maxBytes: number;
}) {
  const service = configuration();
  if (!service || input.maxBytes <= 0) throw new Error("Hosted Reel rendering is unavailable.");
  const { bucket, workspaceId, authUserId, document } = input;
  const session = await resolveWorkspace(authUserId, workspaceId);
  if (session.workspaceId !== workspaceId || session.workspace.status !== "active")
    throw new Error("This workspace is no longer available.");
  const activeScenes = document.scenes.filter((scene) => scene.kind !== "card");
  const mediaIds = [
    ...new Set(activeScenes.flatMap((scene) => (scene.mediaId ? [scene.mediaId] : []))),
  ];
  const media = new Map<string, { key: string; kind: "image" | "video" }>();
  if (mediaIds.length) {
    // The generated types predate the ready Brain Media table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assets = await (supabaseAdmin as any)
      .from("creator_content_media")
      .select("id,storage_key,media_type")
      .eq("user_id", workspaceId)
      .eq("status", "ready")
      .in("id", mediaIds)
      .limit(mediaIds.length);
    if (assets.error) throw new Error("Reel media could not be loaded.");
    for (const asset of assetSchema.array().parse(assets.data)) {
      const key = validateMediaObjectKey(asset.storage_key);
      if (key?.startsWith(`users/${workspaceId}/`))
        media.set(asset.id, { key, kind: asset.media_type });
    }
  }
  const avatarIds = [
    ...new Set(
      activeScenes.flatMap((scene) =>
        scene.kind === "avatar" && !scene.mediaId && scene.avatarJobId ? [scene.avatarJobId] : [],
      ),
    ),
  ];
  for (const id of avatarIds) {
    const job = await readHeyGenJob({ workspaceId, authUserId, clientId: "bento-browser" }, id);
    if (job.status === "ready" && job.assetKey === `private/users/${workspaceId}/heygen/${id}.mp4`)
      media.set(id, { key: job.assetKey, kind: "video" });
  }
  const scenes = document.scenes.map((scene) => {
    if (scene.kind === "card") return scene;
    const id = scene.mediaId ?? (scene.kind === "avatar" ? scene.avatarJobId : null);
    const asset = id && media.get(id);
    if (!asset || (scene.kind === "avatar" && asset.kind !== "video"))
      throw new Error("Choose or finish rendering the Reel scene media first.");
    return { ...scene, mediaId: id };
  });

  const form = new FormData();
  const request: StudioReelRequest = { document: { ...document, scenes }, assets: [] };
  let bytes = 0;
  for (const [id, asset] of media) {
    const object = await bucket.get(asset.key);
    const mime = object?.httpMetadata?.contentType || "";
    const allowed = asset.kind === "image" ? STUDIO_REEL_IMAGE_TYPES : STUDIO_REEL_VIDEO_TYPES;
    if (
      !object ||
      !allowed.includes(mime) ||
      object.size < 1 ||
      bytes + object.size > STUDIO_REEL_INPUT_LIMIT
    ) {
      await object?.body.cancel().catch(() => undefined);
      throw new Error("Hosted rendering supports up to 24 MB of workspace Reel media.");
    }
    bytes += object.size;
    form.set(id, new Blob([await object.arrayBuffer()], { type: mime }), id);
    request.assets.push({ id, kind: asset.kind });
  }
  form.set("document", JSON.stringify(request));
  const reservation = await reserveManagedProviderUsage({
    workspaceId,
    authUserId,
    provider: "bento",
    model: "studio_reel_renderer",
    units: service.cost,
    resource: "studio_reel_browser_milliseconds",
    providerUnits: STUDIO_REEL_TIMEOUT_MS,
  });
  const response = await fetch(service.url, {
    method: "POST",
    headers: { authorization: `Bearer ${service.token}`, accept: "video/mp4" },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(STUDIO_REEL_TIMEOUT_MS + 15_000),
  });
  if (!response.ok || response.headers.get("content-type") !== "video/mp4") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The Reel renderer did not return an MP4.");
  }
  const output = await readResponseBytes(
    response,
    Math.min(input.maxBytes, STUDIO_REEL_OUTPUT_LIMIT),
  );
  if (decoder.decode(output.subarray(4, 8)) !== "ftyp")
    throw new Error("The Reel renderer returned an invalid MP4.");
  await settleProviderUsage(reservation, service.cost);
  const current = await resolveWorkspace(authUserId, workspaceId);
  if (current.workspaceId !== workspaceId || current.workspace.status !== "active")
    throw new Error("This workspace is no longer available.");
  return output;
}
