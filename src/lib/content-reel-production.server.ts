/* eslint-disable @typescript-eslint/no-explicit-any -- Additive production tables precede generated types. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  requireStudioWorkspace,
  saveContentStudioEntryForWorkspace,
} from "./content-studio.server";
import { studioEntrySchema } from "./content-studio";
import { getManagedSpendStatus } from "./provider-budget.server";
import { hostedStudioReelAttemptCost } from "./studio-reel-host.server";
import { studioCarouselJobStatus } from "./studio-carousel-jobs.server";
import { createHeyGenClient } from "./heygen.server";
import {
  approveHeyGenJob,
  prepareHeyGenJob,
  prepareHeyGenSpeechJob,
  readHeyGenJob,
  pollHeyGenJob,
  startHeyGenJob,
  managedHeyGenConnection,
  requireManagedHeyGenAssets,
  heyGenSpeechCost,
  managedHeyGenAvatarCost,
  type ExternalToolActor,
  type ExternalHeyGenJob,
} from "./external-tools.server";
import {
  conformReelNarration,
  reelProductionRequestKey,
  reelProductionStateSchema,
  reelPublicationSchema,
  type ReelProductionState,
  type reelProductionInput,
} from "./content-reel-production";
import { resolveWorkspace } from "./workspace-session.server";
import { enforceRequestRateLimit } from "./request-security.server";

const db = supabaseAdmin as any;
const active = ["queued", "narrating", "avatars", "rendering"];
const rowSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  auth_user_id: z.uuid(),
  entry_id: z.uuid(),
  entry_revision: z.number().int().positive(),
  title: z.string(),
  document: studioEntrySchema.shape.document,
  publication: reelPublicationSchema.nullable().optional(),
  state: reelProductionStateSchema,
  status: z.string(),
  estimated_microusd: z.number().int().positive(),
  estimated_avatar_seconds: z.number().int(),
  media_ids: z.array(z.uuid()),
  approved_at: z.string().nullable(),
  steps: z.number().int(),
  created_at: z.string(),
  lease_id: z.uuid().nullable(),
  lease_expires_at: z.string().nullable(),
  error_code: z.string().nullable(),
});
type Production = z.infer<typeof rowSchema>;
export type ReelProductionMessage = { kind: "studio_reel_production"; jobId: string };
const queue = () =>
  globalThis.__env__?.CONTENT_MEDIA_QUEUE as Queue<ReelProductionMessage> | undefined;
export function reelProductionEnabled() {
  return (
    process.env.BENTO_V2_REEL_PRODUCTION_ENABLED === "true" &&
    process.env.BENTO_MANAGED_HEYGEN_ENABLED === "true" &&
    Boolean(queue()) &&
    Boolean(hostedStudioReelAttemptCost())
  );
}

async function authorize(actor: ExternalToolActor) {
  const session = await resolveWorkspace(actor.authUserId, actor.workspaceId);
  if (session.workspaceId !== actor.workspaceId || session.workspace.status !== "active")
    throw new Error("Workspace is unavailable.");
  await requireStudioWorkspace(actor.workspaceId);
}
export async function loadReelProductionForActor(actor: ExternalToolActor, id: string) {
  await authorize(actor);
  const result = await db
    .from("studio_reel_productions")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .maybeSingle();
  if (result.error || !result.data) throw new Error("Reel production is unavailable.");
  return rowSchema.parse(result.data);
}
const load = loadReelProductionForActor;
function publicProduction(row: Production) {
  return {
    id: row.id,
    entryId: row.entry_id,
    revision: row.entry_revision,
    renderRevision: row.state.renderRevision ?? null,
    title: row.title,
    status: row.status,
    estimatedMicrousd: row.estimated_microusd,
    avatarSeconds: row.estimated_avatar_seconds,
    duration:
      row.document.format === "reel"
        ? row.document.scenes.reduce((sum, scene) => sum + scene.duration, 0)
        : 0,
    mediaIds: row.media_ids,
    publication: row.publication ?? null,
    errorCode: row.error_code,
    reviewPath: `/content?tab=agent&project=${row.entry_id}`,
  };
}
export async function readReelProduction(actor: ExternalToolActor, id: string) {
  return publicProduction(await load(actor, id));
}
export async function reelProductionActivity(actor: ExternalToolActor) {
  if (!reelProductionEnabled()) return [];
  await authorize(actor);
  if (!(await getManagedSpendStatus(actor.workspaceId, { authUserId: actor.authUserId })).eligible)
    return [];
  const result = await db
    .from("studio_reel_productions")
    .select("id,entry_id,title,status,estimated_microusd,media_ids")
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .in("status", ["awaiting_approval", ...active, "ready", "failed", "needs_revision"])
    .gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5);
  if (result.error) throw new Error("Reel activity is unavailable.");
  return z
    .array(
      z.object({
        id: z.uuid(),
        entry_id: z.uuid(),
        title: z.string(),
        status: z.string(),
        estimated_microusd: z.number().int().positive(),
        media_ids: z.array(z.uuid()),
      }),
    )
    .parse(result.data || [])
    .filter((row) => row.status !== "ready" || !row.media_ids.length)
    .map((row) => ({
      id: row.id,
      entryId: row.entry_id,
      title: row.title,
      status: row.status,
      estimatedMicrousd: row.estimated_microusd,
    }));
}
export async function latestReelProduction(actor: ExternalToolActor, entryId: string) {
  await authorize(actor);
  if (!reelProductionEnabled()) return { available: false, job: null };
  if (!(await getManagedSpendStatus(actor.workspaceId, { authUserId: actor.authUserId })).eligible)
    return { available: false, job: null };
  const result = await db
    .from("studio_reel_productions")
    .select("*")
    .eq("entry_id", entryId)
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error("Production status could not be loaded.");
  return {
    available: reelProductionEnabled(),
    job: result.data ? publicProduction(rowSchema.parse(result.data)) : null,
  };
}

export async function prepareReelProduction(
  actor: ExternalToolActor,
  input: z.infer<typeof reelProductionInput>,
) {
  await authorize(actor);
  if (!reelProductionEnabled()) throw new Error("Managed Reel production is not configured.");
  const prior = await db
    .from("studio_reel_productions")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .eq("request_id", input.requestId)
    .maybeSingle();
  if (prior.error) throw new Error("Production could not be loaded.");
  if (prior.data) {
    if (
      prior.data.entry_id !== input.entryId ||
      prior.data.entry_revision !== input.revision ||
      JSON.stringify(prior.data.publication ?? null) !== JSON.stringify(input.publication ?? null)
    )
      throw new Error("Use a new request ID for a changed project.");
    return publicProduction(rowSchema.parse(prior.data));
  }
  await enforceRequestRateLimit(
    "EXPENSIVE_API_RATE_LIMITER",
    "prepare-reel-production",
    actor.workspaceId,
  );
  const saved = await db
    .from("content_studio_entries")
    .select("id,kind,title,revision,document")
    .eq("workspace_id", actor.workspaceId)
    .eq("id", input.entryId)
    .eq("revision", input.revision)
    .maybeSingle();
  if (saved.error || !saved.data)
    throw new Error("Save the current project before preparing production.");
  const entry = studioEntrySchema.parse(saved.data);
  if (entry.kind !== "project" || entry.document.format !== "reel")
    throw new Error("Choose a Reel project.");
  const document = entry.document;
  if (document.scenes.some((scene) => scene.kind === "media" && !scene.mediaId))
    throw new Error("Choose owned B-roll for every media scene before preparing production.");
  if (input.publication) {
    const connections = await db
      .from("social_connections")
      .select("id")
      .eq("user_id", actor.workspaceId)
      .eq("status", "active")
      .in("id", input.publication.connectionIds)
      .limit(input.publication.connectionIds.length);
    if (connections.error || connections.data?.length !== input.publication.connectionIds.length)
      throw new Error("Choose connected publishing accounts in this workspace.");
  }
  if (document.audio?.narrationMediaId)
    throw new Error(
      "This project already has a voiceover. Export it directly or remove it before generating narration.",
    );
  const connection = await managedHeyGenConnection(actor);
  await requireManagedHeyGenAssets(
    actor,
    document.scenes.some((scene) => scene.kind === "avatar" && !scene.mediaId)
      ? document.avatarId
      : undefined,
    document.voiceId,
  );
  if (document.scenes.some((scene) => scene.kind === "avatar" && !scene.mediaId))
    await createHeyGenClient(connection.credential).selection(document.avatarId, document.voiceId);
  let cost = 2 * hostedStudioReelAttemptCost()!;
  let avatarSeconds = 0;
  const state: ReelProductionState = {
    speech: {},
    avatars: {},
    costs: {},
    renderCost: hostedStudioReelAttemptCost()!,
  };
  for (const scene of document.scenes) {
    if (scene.kind === "avatar" && scene.mediaId) continue;
    const script = scene.avatarScript.trim();
    if (!script) {
      if (scene.kind === "avatar") throw new Error("Give each new avatar scene a spoken script.");
      continue;
    }
    let speech: ExternalHeyGenJob | undefined;
    if (scene.narrationJobId) {
      const candidate = await readHeyGenJob(actor, scene.narrationJobId);
      if (
        candidate.status === "ready" &&
        candidate.outputKind === "audio" &&
        candidate.voiceId === document.voiceId &&
        candidate.script === script &&
        candidate.billing === "bento_managed"
      )
        speech = candidate;
    }
    if (!speech)
      speech = await prepareHeyGenSpeechJob(actor, {
        voiceId: document.voiceId,
        script,
        requestedSeconds: Math.ceil(scene.duration),
        billing: "managed",
        requestKey: await reelProductionRequestKey([
          "speech",
          document.voiceId,
          script,
          Math.ceil(scene.duration),
        ]),
      });
    if (["submission_unknown", "asset_unavailable"].includes(speech.status))
      throw new Error(
        "The previous generation needs provider or asset-import review before another attempt.",
      );
    if (["failed", "expired", "revoked"].includes(speech.status)) {
      speech = await prepareHeyGenSpeechJob(actor, {
        voiceId: document.voiceId,
        script,
        requestedSeconds: Math.ceil(scene.duration),
        billing: "managed",
        requestKey: await reelProductionRequestKey([
          "speech-retry",
          input.requestId,
          document.voiceId,
          script,
          Math.ceil(scene.duration),
        ]),
      });
    }
    state.speech[scene.id] = speech.jobId;
    if (speech.status !== "ready" && !state.costs[speech.jobId]) {
      state.costs[speech.jobId] = heyGenSpeechCost(script);
      cost += state.costs[speech.jobId];
    }
    if (scene.kind === "avatar") {
      if (scene.avatarJobId) {
        const clip = await readHeyGenJob(actor, scene.avatarJobId);
        if (
          clip.status === "ready" &&
          clip.avatarId === document.avatarId &&
          clip.voiceId === document.voiceId &&
          clip.script === script &&
          clip.sourceAudioJobId === speech.jobId
        ) {
          state.avatars[scene.id] = clip.jobId;
          continue;
        }
      }
      const seconds = Math.ceil(speech.durationSeconds || scene.duration);
      const segmentCost = managedHeyGenAvatarCost(seconds);
      if (segmentCost > 1_000_000)
        throw new Error("Use shorter avatar appearances to fit the per-generation cost limit.");
      avatarSeconds += seconds;
      cost += segmentCost;
    }
  }
  const allowance = await getManagedSpendStatus(actor.workspaceId, {
    authUserId: actor.authUserId,
  });
  if (
    !allowance.eligible ||
    cost > allowance.monthly.remainingMicrousd ||
    cost > allowance.weekly.remainingMicrousd ||
    (allowance.billing && cost > allowance.billing.remainingMicrousd)
  )
    throw new Error("This production exceeds the available managed allowance.");
  const inserted = await db
    .from("studio_reel_productions")
    .insert({
      workspace_id: actor.workspaceId,
      auth_user_id: actor.authUserId,
      entry_id: entry.id,
      entry_revision: entry.revision,
      title: entry.title,
      request_id: input.requestId,
      document,
      publication: input.publication ?? null,
      state,
      estimated_microusd: cost,
      estimated_avatar_seconds: avatarSeconds,
    })
    .select("*")
    .single();
  if (inserted.error?.code === "23505") {
    const duplicate = await db
      .from("studio_reel_productions")
      .select("*")
      .eq("workspace_id", actor.workspaceId)
      .eq("auth_user_id", actor.authUserId)
      .eq("request_id", input.requestId)
      .maybeSingle();
    if (
      duplicate.data?.entry_id === entry.id &&
      duplicate.data?.entry_revision === entry.revision &&
      JSON.stringify(duplicate.data.publication ?? null) ===
        JSON.stringify(input.publication ?? null)
    )
      return publicProduction(rowSchema.parse(duplicate.data));
  }
  if (inserted.error || !inserted.data) throw new Error("Production could not be prepared.");
  return publicProduction(rowSchema.parse(inserted.data));
}

export async function approveReelProduction(actor: ExternalToolActor, id: string) {
  if (actor.clientId !== "bento-browser")
    throw new Error("Review and approve production in Bento.");
  const row = await load(actor, id);
  if (!reelProductionEnabled()) throw new Error("Production is unavailable.");
  if (row.status === "awaiting_approval") {
    const allowance = await getManagedSpendStatus(actor.workspaceId, {
      authUserId: actor.authUserId,
    });
    if (
      !allowance.eligible ||
      row.estimated_microusd > allowance.monthly.remainingMicrousd ||
      row.estimated_microusd > allowance.weekly.remainingMicrousd ||
      (allowance.billing && row.estimated_microusd > allowance.billing.remainingMicrousd)
    )
      throw new Error("The available managed allowance changed. Review a new estimate.");
    if (Date.now() - Date.parse(row.created_at) > 30 * 60_000)
      throw new Error("This estimate expired. Prepare a new production.");
    const current = await db
      .from("content_studio_entries")
      .select("revision")
      .eq("id", row.entry_id)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (current.error || current.data?.revision !== row.entry_revision)
      throw new Error("The project changed. Review a new production estimate.");
    const changed = await db
      .from("studio_reel_productions")
      .update({
        status: "queued",
        approved_at: new Date().toISOString(),
        next_attempt_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("workspace_id", actor.workspaceId)
      .eq("auth_user_id", actor.authUserId)
      .eq("status", "awaiting_approval")
      .select("id")
      .maybeSingle();
    if (changed.error)
      throw new Error("Another production may already be active. Try again after it finishes.");
  }
  const latest = await load(actor, id);
  if (active.includes(latest.status))
    await queue()?.send({ kind: "studio_reel_production", jobId: id });
  return publicProduction(latest);
}

export async function cancelReelProduction(actor: ExternalToolActor, id: string) {
  if (actor.clientId !== "bento-browser") throw new Error("Cancel production in Bento.");
  const row = await load(actor, id);
  if (row.status === "ready") return publicProduction(row);
  const result = await db
    .from("studio_reel_productions")
    .update({ status: "cancelled", lease_id: null, lease_expires_at: null })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .eq("status", row.status)
    .select("*")
    .maybeSingle();
  if (result.error || !result.data) throw new Error("Production changed. Refresh its status.");
  return publicProduction(rowSchema.parse(result.data));
}

async function advanceProviderJob(actor: ExternalToolActor, jobId: string, approvedCost?: number) {
  let job = await readHeyGenJob(actor, jobId);
  const progressed = job.status !== "ready";
  if (
    ["awaiting_approval", "approved"].includes(job.status) &&
    (!approvedCost || job.estimatedMicrousd > approvedCost)
  )
    throw new Error("estimate_changed");
  if (job.status === "awaiting_approval") job = await approveHeyGenJob(actor, jobId);
  if (job.status === "approved") job = await startHeyGenJob(actor, jobId);
  else if (["queued", "processing", "submitting"].includes(job.status))
    job = await pollHeyGenJob(actor, jobId);
  if (
    ["failed", "submission_unknown", "revoked", "expired", "asset_unavailable"].includes(job.status)
  )
    throw new Error("provider_review_required");
  return { job, progressed };
}

/** One bounded durable step; duplicate deliveries are fenced by the database lease. */
export async function processReelProductionMessage(message: ReelProductionMessage) {
  if (!reelProductionEnabled()) return;
  const current = await db
    .from("studio_reel_productions")
    .select("*")
    .eq("id", message.jobId)
    .maybeSingle();
  if (current.error) throw new Error("Production could not be loaded.");
  if (!current.data) return;
  const row = rowSchema.parse(current.data);
  if (!active.includes(row.status) || !row.approved_at) return;
  if (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now()) return;
  const lease = crypto.randomUUID();
  let claim = db
    .from("studio_reel_productions")
    .update({
      lease_id: lease,
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      steps: Math.min(300, row.steps + 1),
    })
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("steps", row.steps);
  claim = row.lease_id ? claim.eq("lease_id", row.lease_id) : claim.is("lease_id", null);
  const claimed = await claim.select("id").maybeSingle();
  if (claimed.error) throw new Error("Production could not be claimed.");
  if (!claimed.data) return;
  const actor = {
    workspaceId: row.workspace_id,
    authUserId: row.auth_user_id,
    clientId: "bento-browser",
  };
  const state = row.state;
  async function finish(status: string, values: Record<string, unknown> = {}, delay = 15) {
    const result = await db
      .from("studio_reel_productions")
      .update({
        status,
        state,
        ...values,
        lease_id: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString(),
        next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
      })
      .eq("id", row.id)
      .eq("lease_id", lease)
      .eq("status", row.status)
      .select("id")
      .maybeSingle();
    if (result.error) throw new Error("Production status could not be saved.");
    if (result.data && active.includes(status))
      await queue()?.send(message, { delaySeconds: delay });
    console.info("reel_production_step", {
      jobId: row.id,
      workspaceId: row.workspace_id,
      status,
      step: row.steps + 1,
    });
  }
  try {
    await authorize(actor);
    await managedHeyGenConnection(actor);
    if (row.steps >= 299 || Date.now() - Date.parse(row.approved_at) > 2 * 60 * 60_000)
      throw new Error("production_deadline");
    if (row.document.format !== "reel") throw new Error("invalid_document");
    const currentEntry = await db
      .from("content_studio_entries")
      .select("revision,document")
      .eq("workspace_id", row.workspace_id)
      .eq("id", row.entry_id)
      .maybeSingle();
    if (
      currentEntry.error ||
      !currentEntry.data ||
      (currentEntry.data.revision !== (state.renderRevision ?? row.entry_revision) &&
        !(
          state.completedDocument &&
          currentEntry.data.revision === row.entry_revision + 1 &&
          JSON.stringify(studioEntrySchema.shape.document.parse(currentEntry.data.document)) ===
            JSON.stringify(state.completedDocument)
        ))
    )
      throw new Error("project_changed");
    const original = row.document;
    const audio = new Map<string, ExternalHeyGenJob>();
    for (const [sceneId, jobId] of Object.entries(state.speech)) {
      const { job, progressed } = await advanceProviderJob(actor, jobId, state.costs[jobId]);
      if (job.status !== "ready") return finish("narrating");
      audio.set(sceneId, job);
      if (progressed) return finish("narrating", {}, 0);
    }
    const document = conformReelNarration(original, audio);
    // Enforce the approval ceiling before creating any avatar video, using measured audio lengths.
    const avatarScenes = document.scenes.filter(
      (scene) => scene.kind === "avatar" && !scene.mediaId,
    );
    const futureAvatars = new Map<string, number>();
    for (const scene of avatarScenes)
      if (!state.avatars[scene.id]) {
        const speech = audio.get(scene.id);
        if (!speech?.durationSeconds) throw new Error("missing_narration");
        futureAvatars.set(speech.jobId, managedHeyGenAvatarCost(Math.ceil(speech.durationSeconds)));
      }
    const measuredCost =
      Object.values(state.costs).reduce(
        (sum, cost) => sum + cost,
        2 * hostedStudioReelAttemptCost()!,
      ) + [...futureAvatars.values()].reduce((sum, cost) => sum + cost, 0);
    if (measuredCost > row.estimated_microusd) throw new Error("estimate_changed");
    if (!state.renderCost || hostedStudioReelAttemptCost()! > state.renderCost)
      throw new Error("estimate_changed");
    for (const scene of avatarScenes) {
      const narration = audio.get(scene.id);
      if (!narration?.durationSeconds) throw new Error("missing_narration");
      let jobId = state.avatars[scene.id];
      if (!jobId) {
        const request = {
          avatarId: document.avatarId,
          voiceId: document.voiceId,
          script: scene.avatarScript.trim(),
          billing: "managed" as const,
          sourceAudioJobId: narration.jobId,
          requestedSeconds: Math.ceil(narration.durationSeconds),
          requestKey: await reelProductionRequestKey([
            "avatar",
            document.avatarId,
            document.voiceId,
            narration.jobId,
          ]),
        };
        let clip = await prepareHeyGenJob(actor, request);
        if (["submission_unknown", "asset_unavailable"].includes(clip.status))
          throw new Error("provider_review_required");
        if (["failed", "expired", "revoked"].includes(clip.status)) {
          clip = await prepareHeyGenJob(actor, {
            ...request,
            requestKey: await reelProductionRequestKey([
              "avatar-retry",
              row.id,
              document.avatarId,
              narration.jobId,
            ]),
          });
        }
        jobId = state.avatars[scene.id] = clip.jobId;
        if (clip.status !== "ready") state.costs[jobId] = clip.estimatedMicrousd;
        // Save the stable job ID before a paid submission; recovery cannot invent another request.
        return finish("avatars", {}, 0);
      }
      const { job: clip, progressed } = await advanceProviderJob(actor, jobId, state.costs[jobId]);
      if (clip.status !== "ready") return finish("avatars");
      if (progressed) return finish("avatars", {}, 0);
      if (!clip.durationSeconds || clip.durationSeconds + 0.1 < scene.duration)
        throw new Error("avatar_too_short");
      scene.avatarJobId = jobId;
    }
    if (
      !state.completedDocument ||
      JSON.stringify(state.completedDocument) !== JSON.stringify(document)
    ) {
      state.completedDocument = document;
      return finish("rendering", {}, 0);
    }
    if (!state.renderRevision) {
      const saved = await saveContentStudioEntryForWorkspace(row.workspace_id, {
        id: row.entry_id,
        kind: "project",
        title: row.title,
        revision: row.entry_revision,
        document,
      });
      state.renderRevision = saved.revision;
      return finish("rendering", {}, 0);
    }
    const input = {
      workspaceId: row.workspace_id,
      entryId: row.entry_id,
      revision: state.renderRevision,
      format: "reel" as const,
    };
    const rendered = await studioCarouselJobStatus(input, row.auth_user_id);
    if (rendered.job && (!rendered.job.private_output || rendered.job.production_id !== row.id))
      throw new Error("render_unavailable");
    if (rendered.job?.status === "ready") {
      state.renderJobId = rendered.job.id;
      return finish("ready", { media_ids: rendered.job.media_ids });
    }
    if (rendered.job?.status === "failed") throw new Error("render_failed");
    if (!rendered.job || rendered.job.status === "queued") {
      let renderJobId = rendered.job?.id;
      if (!renderJobId) {
        const queued = await db.rpc("queue_studio_reel_production_render", {
          p_production_id: row.id,
        });
        if (queued.error || !queued.data) throw new Error("render_unavailable");
        renderJobId = z.uuid().parse(queued.data);
      }
      const mediaQueue = globalThis.__env__?.CONTENT_MEDIA_QUEUE as
        Queue<{ kind: "studio_carousel_render"; jobId: string }> | undefined;
      await mediaQueue?.send({ kind: "studio_carousel_render", jobId: renderJobId });
    }
    return finish("rendering");
  } catch (error) {
    const code = error instanceof Error ? error.message : "production_failed";
    // Never automatically create a second paid generation after an uncertain submission.
    await finish(
      ["estimate_changed", "avatar_too_short", "missing_narration", "project_changed"].includes(
        code,
      ) || /narration|script|B-roll|scene/i.test(code)
        ? "needs_revision"
        : "failed",
      {
        error_code: [
          "estimate_changed",
          "avatar_too_short",
          "provider_review_required",
          "production_deadline",
          "render_failed",
          "project_changed",
        ].includes(code)
          ? code
          : "production_stopped",
      },
    );
  }
}

export async function enqueueDueReelProductions() {
  if (!reelProductionEnabled()) return;
  const due = await db
    .from("studio_reel_productions")
    .select("id")
    .in("status", active)
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at")
    .limit(20);
  if (due.error) throw new Error("Due productions could not be loaded.");
  for (const row of due.data || [])
    await queue()?.send({ kind: "studio_reel_production", jobId: row.id });
}
