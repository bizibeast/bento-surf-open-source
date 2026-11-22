/* eslint-disable @typescript-eslint/no-explicit-any -- These tables and RPCs ship with the additive migrations. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { carouselCopyIssues } from "./content-carousel";
import { requireStudioWorkspace } from "./content-studio.server";
import {
  studioCarouselPhotoId,
  studioDocumentSchema,
  studioMediaReferences,
  type StudioCarousel,
  type StudioReel,
} from "./content-studio";
import { getPlan, getStorageAllowanceMb } from "./plan.server";
import { uploadLimitMb } from "./plans";
import { getMediaBucket, mediaObjectUrl, sumR2UserStorageBytes } from "./r2-storage.server";
import { adjustCachedR2UserStorageBytes, cachedR2UserStorageBytes } from "./r2-usage-cache.server";
import type { studioCarouselJobInput, StudioCarouselMessage } from "./studio-carousel-job";
import { getManagedSpendStatus } from "./provider-budget.server";
import { hostedStudioReelAttemptCost, renderStudioReelOnHost } from "./studio-reel-host.server";
import { STUDIO_REEL_OUTPUT_LIMIT } from "./studio-reel-host";

const db = supabaseAdmin as any;
const outputBytesLimit = 2 * 1024 * 1024;
const leaseMs = 8 * 60_000;
type ClientInput = z.infer<typeof studioCarouselJobInput>;
const jobStatus = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "rendering", "ready", "failed"]),
  media_ids: z.array(z.uuid()).max(10),
  production_id: z.uuid().nullish(),
  private_output: z.boolean().optional(),
});
const claimedJob = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  title: z.string(),
  document: studioDocumentSchema,
  requested_by: z.uuid().nullish(),
  attempts: z.number().int(),
  max_attempt_microusd: z.number().int().positive().nullish(),
  production_id: z.uuid().nullish(),
  private_output: z.boolean().optional(),
});

function queueBinding() {
  return globalThis.__env__?.CONTENT_MEDIA_QUEUE as Queue<StudioCarouselMessage> | undefined;
}

function enabled(format: ClientInput["format"] = "carousel") {
  return (
    Boolean(queueBinding()) &&
    (format === "reel"
      ? Boolean(hostedStudioReelAttemptCost())
      : process.env.BENTO_V2_STUDIO_SERVER_CAROUSELS === "true")
  );
}

function photosAvailable() {
  return process.env.BENTO_V2_STUDIO_SERVER_CAROUSEL_PHOTOS === "true";
}

async function getRenderJob(
  { workspaceId, entryId, revision, format = "carousel" }: ClientInput,
  authUserId: string,
) {
  const query = db
    .from("studio_carousel_render_jobs")
    .select("id,status,media_ids,production_id,private_output")
    .eq("workspace_id", workspaceId)
    .eq("entry_id", entryId)
    .eq("revision", revision)
    .eq("document->>format", format);
  if (format === "reel") query.eq("requested_by", authUserId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("The background render could not be loaded.");
  return data ? jobStatus.parse(data) : null;
}

export async function studioCarouselJobStatus(input: ClientInput, authUserId: string) {
  const unavailable = { available: false, photosAvailable: false, costMicrousd: null, job: null };
  if (!enabled(input.format)) return unavailable;
  await requireStudioWorkspace(input.workspaceId);
  if (
    input.format === "reel" &&
    !(await getManagedSpendStatus(input.workspaceId, { authUserId })).eligible
  )
    return unavailable;
  return {
    available: true,
    photosAvailable: photosAvailable(),
    costMicrousd: input.format === "reel" ? hostedStudioReelAttemptCost() : null,
    job: await getRenderJob(input, authUserId),
  };
}

export async function queueStudioCarouselJob(input: ClientInput, authUserId: string) {
  const queue = queueBinding();
  if (!enabled(input.format) || !queue) throw new Error("Background rendering is unavailable.");
  await requireStudioWorkspace(input.workspaceId);
  const reel = input.format === "reel";
  if (reel && !(await getManagedSpendStatus(input.workspaceId, { authUserId })).eligible)
    throw new Error("Hosted Reel rendering requires an active Creator+ allowance.");
  const { data, error } = await db.rpc(
    reel ? "queue_studio_reel_render" : "queue_studio_carousel_render",
    {
      p_workspace_id: input.workspaceId,
      p_entry_id: input.entryId,
      p_revision: input.revision,
      ...(reel ? { p_auth_user_id: authUserId } : {}),
    },
  );
  if (error || !data)
    throw new Error("Save the current project or try again after the daily render limit resets.");
  const job = await getRenderJob(input, authUserId);
  if (!job) throw new Error("The background render could not be queued.");
  if (job.status === "queued") await queue.send({ kind: "studio_carousel_render", jobId: job.id });
  return job;
}

type RenderJob = z.infer<typeof claimedJob>;

async function storeRender(
  bucket: R2Bucket,
  workspaceId: string,
  key: string,
  mime: string,
  bytes: Uint8Array,
) {
  await bucket.put(key, new Uint8Array(bytes), {
    httpMetadata: { contentType: mime, cacheControl: "public, max-age=31536000, immutable" },
  });
  await adjustCachedR2UserStorageBytes(workspaceId, bytes.length).catch(() => undefined);
}

async function registerRender(
  workspaceId: string,
  key: string,
  name: string,
  mime: string,
  size: number,
) {
  const { data, error } = await db.rpc("register_creator_uploaded_media", {
    p_user_id: workspaceId,
    p_key: key,
    p_url: mediaObjectUrl(key),
    p_name: name,
    p_mime: mime,
    p_bytes: size,
  });
  if (error || !data) throw new Error("The export could not be added to Media.");
  return z.uuid().parse(data);
}

async function runReelRender(job: RenderJob, document: StudioReel) {
  const { id, workspace_id: workspaceId, title, requested_by: authUserId } = job;
  if (!authUserId) throw new Error("The render requester is unavailable.");
  if (
    job.max_attempt_microusd &&
    (hostedStudioReelAttemptCost() ?? Infinity) > job.max_attempt_microusd
  )
    throw new Error("The approved render price changed. Review a new production estimate.");
  const bucket = getMediaBucket();
  const key = job.private_output
    ? `private/users/${workspaceId}/studio/${id}.mp4`
    : `users/${workspaceId}/video/studio-${id}.mp4`;
  const existing = await bucket.head(key);
  let size = existing?.size;
  if (size === undefined) {
    const [allowanceMb, plan, storedBytes] = await Promise.all([
      getStorageAllowanceMb(workspaceId),
      getPlan(workspaceId),
      cachedR2UserStorageBytes(bucket, workspaceId, sumR2UserStorageBytes),
    ]);
    const maxBytes = Math.min(
      STUDIO_REEL_OUTPUT_LIMIT,
      uploadLimitMb("video", plan) * 1024 * 1024,
      allowanceMb * 1024 * 1024 - storedBytes,
    );
    const bytes = await renderStudioReelOnHost({
      bucket,
      workspaceId,
      authUserId,
      document,
      maxBytes,
    });
    if (job.private_output) {
      await bucket.put(key, new Uint8Array(bytes), {
        httpMetadata: { contentType: "video/mp4", cacheControl: "private, no-store" },
      });
      await adjustCachedR2UserStorageBytes(workspaceId, bytes.length).catch(() => undefined);
    } else await storeRender(bucket, workspaceId, key, "video/mp4", bytes);
    size = bytes.length;
  }
  return job.private_output
    ? []
    : [await registerRender(workspaceId, key, `${title}.mp4`, "video/mp4", size)];
}

async function runCarouselRender(job: RenderJob, document: StudioCarousel) {
  const { id, workspace_id: workspaceId, title } = job;
  const issues = carouselCopyIssues(document.slides);
  if (issues.length) throw new Error(issues[0]);
  if (document.brand.coverStyle === "portrait" && !studioCarouselPhotoId(document, 0))
    throw new Error("Choose a cover portrait or switch to a text cover.");
  const photoIds = [
    ...new Set(studioMediaReferences(document).filter((id): id is string => Boolean(id))),
  ];
  const photoKeys = new Map<string, string>();
  if (photoIds.length > 0) {
    if (!photosAvailable()) throw new Error("Background photo carousels are unavailable.");
    const { data, error } = await db
      .from("creator_content_media")
      .select("id,storage_key")
      .eq("user_id", workspaceId)
      .eq("status", "ready")
      .eq("media_type", "image")
      .in("id", photoIds)
      .limit(photoIds.length);
    if (error) throw new Error("The slide photos could not be loaded.");
    const assets = z.array(z.object({ id: z.uuid(), storage_key: z.string() })).parse(data);
    for (const { id, storage_key } of assets) photoKeys.set(id, storage_key);
    if (photoIds.some((id) => !photoKeys.has(id)))
      throw new Error("A slide photo is unavailable in this workspace.");
  }
  const { renderAgentCarouselSlide } = await import("./content-carousel-render.server");
  const bucket = getMediaBucket();
  const [allowanceMb, plan, initialBytes] = await Promise.all([
    getStorageAllowanceMb(workspaceId),
    getPlan(workspaceId),
    cachedR2UserStorageBytes(bucket, workspaceId, sumR2UserStorageBytes),
  ]);
  let storedBytes = initialBytes;
  const maxSlideBytes = Math.min(outputBytesLimit, uploadLimitMb("image", plan) * 1024 * 1024);
  const mediaIds: string[] = [];
  for (const [index, slide] of document.slides.entries()) {
    const key = `users/${workspaceId}/image/studio-${id}-${index + 1}.png`;
    const existing = await bucket.head(key);
    let size = existing?.size;
    if (size === undefined) {
      const photoId = studioCarouselPhotoId(document, index);
      const photoKey = photoId && photoKeys.get(photoId);
      const portrait = photoKey
        ? await (
            await import("./studio-carousel-photo.server")
          ).loadStudioCarouselPhoto(bucket, workspaceId, photoKey)
        : undefined;
      const bytes = await renderAgentCarouselSlide({
        slide,
        index,
        count: document.slides.length,
        brand: document.brand,
        portrait,
        layout: document.layout,
      });
      if (
        !bytes.length ||
        bytes.length > maxSlideBytes ||
        storedBytes + bytes.length > allowanceMb * 1024 * 1024
      )
        throw new Error("The carousel could not fit in your Media storage.");
      await storeRender(bucket, workspaceId, key, "image/png", bytes);
      size = bytes.length;
      storedBytes += size;
    }
    mediaIds.push(
      await registerRender(workspaceId, key, `${title} ${index + 1}.png`, "image/png", size),
    );
  }
  return mediaIds;
}

export async function processStudioCarouselMessage(message: StudioCarouselMessage) {
  if (!enabled() && !enabled("reel")) return "ack" as const;
  const now = new Date();
  const lease = crypto.randomUUID();
  const jobId = message.jobId;
  const table = () => db.from("studio_carousel_render_jobs");
  const current = await table()
    .select("id,status,attempts,lease_expires_at")
    .eq("id", jobId)
    .maybeSingle();
  if (current.error) throw new Error("The render job could not be loaded.");
  if (!current.data || ["ready", "failed"].includes(current.data.status)) return "ack" as const;
  if (
    current.data.status === "rendering" &&
    Date.parse(current.data.lease_expires_at) > now.getTime()
  )
    return "retry" as const;
  const attempts = Number(current.data.attempts);
  const claim = await table()
    .update(
      attempts >= 2
        ? { status: "failed", lease_id: null, lease_expires_at: null }
        : {
            status: "rendering",
            attempts: attempts + 1,
            lease_id: lease,
            lease_expires_at: new Date(now.getTime() + leaseMs).toISOString(),
          },
    )
    .eq("id", jobId)
    .eq("status", current.data.status)
    .eq("attempts", attempts)
    .select(
      "id,workspace_id,title,document,attempts,requested_by,max_attempt_microusd,production_id,private_output",
    )
    .maybeSingle();
  if (claim.error) throw new Error("The render job could not be claimed.");
  if (!claim.data) return "retry" as const;
  if (attempts >= 2) return "ack" as const;
  async function finish(values: { status: "ready" | "queued" | "failed"; media_ids?: string[] }) {
    const updated = await table()
      .update({ ...values, lease_id: null, lease_expires_at: null })
      .eq("id", jobId)
      .eq("lease_id", lease)
      .select("id")
      .maybeSingle();
    if (updated.error || !updated.data)
      throw new Error("The background render status could not be written.");
  }
  let mediaIds: string[];
  try {
    const job = claimedJob.parse(claim.data);
    await requireStudioWorkspace(job.workspace_id);
    if (!enabled(job.document.format)) throw new Error("Background rendering is unavailable.");
    mediaIds =
      job.document.format === "reel"
        ? await runReelRender(job, job.document)
        : await runCarouselRender(job, job.document);
  } catch {
    await finish({ status: attempts === 0 ? "queued" : "failed" });
    return attempts === 0 ? ("retry" as const) : ("ack" as const);
  }
  await finish({ status: "ready", media_ids: mediaIds });
  return "ack" as const;
}
