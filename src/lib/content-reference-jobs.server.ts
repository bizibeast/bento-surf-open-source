/* eslint-disable @typescript-eslint/no-explicit-any -- Additive private job table has validated boundaries. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  contentReferenceInput,
  referenceEvidenceSchema,
  REFERENCE_ASSET_PATH,
  REFERENCE_MAX_BYTES,
} from "./content-reference";
import {
  analyzeReferenceMedia,
  downloadInstagramReference,
  type ReferenceActor,
  type ReferenceMedia,
} from "./content-reference-analysis.server";
import { requireContentWorkspace } from "./content-access.server";
import { resolveWorkspace } from "./workspace-session.server";
import { getMediaBucket, validateMediaObjectKey } from "./r2-storage.server";
import {
  getManagedSpendStatus,
  withManagedProviderBudget,
  withProviderBudgetWorkspace,
} from "./provider-budget.server";
import { isSelfHostedEdition } from "./plan.server";
import type { PlanId } from "./plans";
import { encryptServerSecret, decryptServerSecret } from "./secret-crypto.server";
import type { AiProviderEnv } from "./ai-json.server";
import { enforceRequestRateLimit } from "./request-security.server";

const db = () => supabaseAdmin as any;
export type ContentReferenceMessage = { kind: "content_reference_analysis"; jobId: string };
const jobInput = z.object({ request: contentReferenceInput, gridOnly: z.boolean() }).strict();
const rowSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  auth_user_id: z.uuid(),
  input: jobInput,
  status: z.enum(["queued", "processing", "ready", "failed"]),
  evidence: referenceEvidenceSchema.nullable(),
  has_grid: z.boolean(),
  error_message: z.string().nullable(),
  expires_at: z.string(),
  attempts: z.number().int(),
  lease_id: z.uuid().nullable(),
});
const grantSchema = z
  .object({
    purpose: z.literal("reference_preview"),
    workspaceId: z.uuid(),
    authUserId: z.uuid(),
    jobId: z.uuid(),
    asset: z.enum(["grid.jpg", "grid.json"]),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const queue = () =>
  globalThis.__env__?.CONTENT_MEDIA_QUEUE as Queue<ContentReferenceMessage> | undefined;
export const isContentReferenceEnabled = () =>
  process.env.BENTO_V2_REFERENCE_ANALYSIS_ENABLED === "true" && !!queue();
const prefix = (workspaceId: string, jobId: string) =>
  `private/users/${workspaceId}/references/${jobId}/`;

export async function requireReferenceActor(actor: ReferenceActor) {
  if (!isContentReferenceEnabled()) throw new Error("Reference analysis is unavailable.");
  const session = await resolveWorkspace(actor.authUserId, actor.workspaceId);
  if (session.workspaceId !== actor.workspaceId || session.workspace.status !== "active")
    throw new Error("This workspace is unavailable.");
  return requireContentWorkspace(actor.workspaceId, "discover");
}

export function withReferenceProviderBudget<T>(actor: ReferenceActor, plan: PlanId, work: () => T) {
  if (plan === "creator_plus" && !isSelfHostedEdition())
    return withManagedProviderBudget(actor, work);
  return withProviderBudgetWorkspace(actor.workspaceId, work);
}

function needsVideoAllowance(request: z.infer<typeof contentReferenceInput>, gridOnly: boolean) {
  return (
    gridOnly ||
    !!request.mediaId ||
    request.sourceUrl?.startsWith("https://www.instagram.com/reel/")
  );
}

async function requireVideoAllowance(actor: ReferenceActor, plan: PlanId) {
  const status =
    plan === "creator_plus" &&
    (await getManagedSpendStatus(actor.workspaceId, { authUserId: actor.authUserId }));
  if (
    !status ||
    !status.eligible ||
    status.weekly.remainingMicrousd === 0 ||
    status.monthly.remainingMicrousd === 0 ||
    status.billing?.remainingMicrousd === 0
  )
    throw new Error(
      "Hosted video frame analysis requires an active Creator+ allowance. Creator can use their external AI environment.",
    );
}

async function getJob(actor: ReferenceActor, id: string) {
  const result = await db()
    .from("content_reference_jobs")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (result.error || !result.data)
    throw new Error("This reference is unavailable in this workspace or has expired.");
  return rowSchema.parse(result.data);
}

async function publicJob(actor: ReferenceActor, row: z.infer<typeof rowSchema>) {
  const link = async (asset: "grid.jpg" | "grid.json") => {
    const grant: z.infer<typeof grantSchema> = {
      purpose: "reference_preview",
      workspaceId: actor.workspaceId,
      authUserId: actor.authUserId,
      jobId: row.id,
      asset,
      expiresAt: Date.now() + 10 * 60_000,
    };
    const url = new URL(REFERENCE_ASSET_PATH, process.env.VITE_APP_URL || "http://localhost:8080");
    url.searchParams.set(
      "grant",
      await encryptServerSecret(JSON.stringify(grant), "external-tool"),
    );
    return url.href;
  };
  return {
    id: row.id,
    status: row.status,
    evidence: row.evidence,
    error: row.error_message,
    expiresAt: row.expires_at,
    ...(row.status === "ready" && row.has_grid
      ? { gridUrl: await link("grid.jpg"), frameMetadataUrl: await link("grid.json") }
      : {}),
    reviewPath: `/content?tab=agent&reference=${row.id}`,
  };
}

export async function queueContentReference(
  actor: ReferenceActor,
  input: z.input<typeof contentReferenceInput>,
  gridOnly = false,
) {
  const request = contentReferenceInput.parse(input);
  if (request.workspaceId !== actor.workspaceId)
    throw new Error("This reference belongs to another workspace.");
  const plan = await requireReferenceActor(actor);
  if (needsVideoAllowance(request, gridOnly)) await requireVideoAllowance(actor, plan);
  const result = await db().rpc("queue_content_reference", {
    p_workspace_id: actor.workspaceId,
    p_auth_user_id: actor.authUserId,
    p_request_id: request.requestId,
    p_input: { request, gridOnly },
  });
  if (result.error || !result.data)
    throw new Error(
      "A reference is already running, its request changed, or the reference limit has been reached. Read the existing job before trying a new request.",
    );
  const row = await getJob(actor, z.uuid().parse(result.data));
  if (row.status === "queued")
    await queue()!.send({ kind: "content_reference_analysis", jobId: row.id });
  return publicJob(actor, row);
}

export async function readContentReference(actor: ReferenceActor, id: string) {
  await requireReferenceActor(actor);
  return publicJob(actor, await getJob(actor, z.uuid().parse(id)));
}

export async function listContentReferences(actor: ReferenceActor) {
  await requireReferenceActor(actor);
  const result = await db()
    .from("content_reference_jobs")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  if (result.error) throw new Error("Your references could not be loaded.");
  return Promise.all(
    rowSchema
      .array()
      .parse(result.data || [])
      .map((row) => publicJob(actor, row)),
  );
}

export async function loadReferenceEvidence(actor: ReferenceActor, id: string) {
  await requireReferenceActor(actor);
  const row = await getJob(actor, z.uuid().parse(id));
  if (row.status !== "ready" || !row.evidence)
    throw new Error("Wait until this reference analysis is ready.");
  return row.evidence;
}

async function ownedVideo(workspaceId: string, mediaId: string): Promise<ReferenceMedia> {
  const result = await db()
    .from("creator_content_media")
    .select("storage_key,mime_type,media_type")
    .eq("user_id", workspaceId)
    .eq("id", mediaId)
    .eq("status", "ready")
    .maybeSingle();
  const key = validateMediaObjectKey(result.data?.storage_key || "");
  if (
    result.error ||
    !key?.startsWith(`users/${workspaceId}/`) ||
    result.data?.media_type !== "video"
  )
    throw new Error("Choose a ready video from this workspace's Files.");
  const object = await getMediaBucket().get(key);
  const mime = object?.httpMetadata?.contentType || "";
  if (!object || object.size > REFERENCE_MAX_BYTES || !["video/mp4", "video/webm"].includes(mime)) {
    await object?.body.cancel();
    throw new Error("Choose an MP4 or WebM video of 24 MB or less.");
  }
  return { kind: "video", mime, bytes: new Uint8Array(await object.arrayBuffer()) };
}

/** Atomic claim permits one provider attempt. Lost or ambiguous executions are never replayed. */
export async function processContentReferenceMessage(message: ContentReferenceMessage) {
  if (!isContentReferenceEnabled() || !z.uuid().safeParse(message.jobId).success) return;
  const lease = crypto.randomUUID();
  const claimed = await db()
    .from("content_reference_jobs")
    .update({
      status: "processing",
      attempts: 1,
      lease_id: lease,
      lease_expires_at: new Date(Date.now() + 8 * 60_000).toISOString(),
    })
    .eq("id", message.jobId)
    .eq("status", "queued")
    .eq("attempts", 0)
    .gt("expires_at", new Date().toISOString())
    .select("*")
    .maybeSingle();
  if (claimed.error) throw new Error("The reference job could not be claimed.");
  if (!claimed.data) return;
  const row = rowSchema.parse(claimed.data);
  const actor = { workspaceId: row.workspace_id, authUserId: row.auth_user_id };
  try {
    const plan = await requireReferenceActor(actor);
    const { request, gridOnly } = row.input;
    const knownVideo = needsVideoAllowance(request, gridOnly);
    if (knownVideo) await requireVideoAllowance(actor, plan);
    const output = await withReferenceProviderBudget(actor, plan, async () => {
      const loaded = request.sourceUrl
        ? await downloadInstagramReference(actor, request.sourceUrl)
        : { source: {}, assets: [await ownedVideo(actor.workspaceId, request.mediaId!)] };
      if (!knownVideo && loaded.assets.some((item) => item.kind === "video"))
        await requireVideoAllowance(actor, plan);
      const source = loaded.source as { owner?: string; caption?: string };
      return analyzeReferenceMedia(
        actor,
        row.id,
        loaded.assets,
        request.mode,
        (globalThis.__env__ || {}) as unknown as AiProviderEnv,
        {
          ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}),
          ...(source.owner ? { owner: source.owner } : {}),
          ...(source.caption ? { caption: source.caption } : {}),
        },
        gridOnly,
      );
    });
    await requireReferenceActor(actor);
    const saved = await db()
      .from("content_reference_jobs")
      .update({
        status: "ready",
        evidence: output.evidence,
        has_grid: output.hasGrid,
        lease_expires_at: null,
      })
      .eq("id", row.id)
      .eq("workspace_id", actor.workspaceId)
      .eq("lease_id", lease)
      .eq("status", "processing")
      .gt("lease_expires_at", new Date().toISOString())
      .select("id")
      .maybeSingle();
    if (saved.error || !saved.data) throw new Error("The reference result could not be saved.");
    console.log("content_reference_ready", {
      jobId: row.id,
      workspaceId: actor.workspaceId,
      visuals: output.evidence.visuals.length,
      hasGrid: output.hasGrid,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "Reference analysis could not finish.";
    await db()
      .from("content_reference_jobs")
      .update({ status: "failed", error_message: message, lease_expires_at: null })
      .eq("id", row.id)
      .eq("lease_id", lease)
      .eq("status", "processing");
    console.warn("content_reference_failed", { jobId: row.id, workspaceId: actor.workspaceId });
  }
}

async function recoverReferenceQueue() {
  const sender = queue();
  if (process.env.BENTO_V2_REFERENCE_ANALYSIS_ENABLED !== "true" || !sender) return;
  const stale = await db()
    .from("content_reference_jobs")
    .update({
      status: "failed",
      error_message: "Analysis was interrupted. No provider request has been retried.",
    })
    .eq("status", "processing")
    .lt("lease_expires_at", new Date().toISOString());
  if (stale.error) throw new Error("Interrupted reference jobs could not be recovered.");
  const pending = await db()
    .from("content_reference_jobs")
    .select("id")
    .eq("status", "queued")
    .gt("expires_at", new Date().toISOString())
    .order("created_at")
    .limit(10);
  if (pending.error) throw new Error("Queued reference jobs could not be loaded.");
  const sends = await Promise.allSettled(
    (pending.data || []).map(async (job: { id: unknown }) =>
      sender.send({ kind: "content_reference_analysis", jobId: z.uuid().parse(job.id) }),
    ),
  );
  if (sends.some(({ status }) => status === "rejected"))
    throw new Error("Queued reference jobs could not all be sent.");
}

async function expireContentReferences() {
  const expired = await db()
    .from("content_reference_jobs")
    .select("id,workspace_id")
    .lt("expires_at", new Date().toISOString())
    .is("cleaned_at", null)
    .order("expires_at")
    .limit(20);
  if (expired.error) {
    // Deployments that have never enabled references do not require the reference schema.
    if (
      process.env.BENTO_V2_REFERENCE_ANALYSIS_ENABLED !== "true" &&
      ["PGRST205", "42P01"].includes(expired.error.code)
    )
      return;
    throw new Error("Expired reference jobs could not be loaded.");
  }
  let cleanupFailed = false;
  for (const job of expired.data || []) {
    const id = z.uuid().parse(job.id),
      workspaceId = z.uuid().parse(job.workspace_id);
    try {
      await getMediaBucket().delete([
        `${prefix(workspaceId, id)}grid.jpg`,
        `${prefix(workspaceId, id)}grid.json`,
      ]);
    } catch {
      cleanupFailed = true;
      continue;
    }
    const cleaned = await db()
      .from("content_reference_jobs")
      .update({
        evidence: null,
        has_grid: false,
        cleaned_at: new Date().toISOString(),
        status: "failed",
        error_message: "This reference has expired.",
      })
      .eq("id", id)
      .eq("workspace_id", workspaceId);
    cleanupFailed ||= !!cleaned.error;
  }
  const purged = await db().rpc("purge_content_reference_receipts");
  if (cleanupFailed || purged.error)
    throw new Error("Expired references could not all be cleaned.");
}

/** Expiration must run even when new work has been disabled or queue submission fails. */
export async function recoverContentReferences() {
  const results = await Promise.allSettled([expireContentReferences(), recoverReferenceQueue()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Reference maintenance was incomplete.");
}

export async function handleContentReferenceAssetRequest(request: Request) {
  const missing = () =>
    new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!isContentReferenceEnabled()) return missing();
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const token = new URL(request.url).searchParams.get("grant");
  if (!token || token.length > 1200) return missing();
  try {
    await enforceRequestRateLimit(
      "PUBLIC_API_RATE_LIMITER",
      "reference-asset",
      request.headers.get("cf-connecting-ip") || "missing-cloudflare-ip",
    );
    const grant = grantSchema.parse(JSON.parse(await decryptServerSecret(token, "external-tool")));
    if (grant.expiresAt < Date.now() || grant.expiresAt > Date.now() + 11 * 60_000)
      return missing();
    await requireReferenceActor(grant);
    const row = await getJob(grant, grant.jobId);
    if (row.status !== "ready" || !row.has_grid) return missing();
    const object = await getMediaBucket().get(
      `${prefix(grant.workspaceId, grant.jobId)}${grant.asset}`,
    );
    if (!object || object.size > 4 * 1024 * 1024) {
      await object?.body.cancel();
      return missing();
    }
    const headers = {
      "content-type": grant.asset === "grid.jpg" ? "image/jpeg" : "application/json",
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    if (request.method === "HEAD") {
      await object.body.cancel();
      return new Response(null, { headers });
    }
    return new Response(object.body, { headers });
  } catch {
    return missing();
  }
}
