import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  externalCredentialSchema,
  externalToolNames,
  githubPullRequestSchema,
  HEYGEN_MODEL_DESCRIPTION,
  heyGenEstimateRenderSeconds,
  heyGenEstimateUsd,
  type ExternalProvider,
  type HeyGenCatalogInput,
  type HeyGenGenerationInput,
  type HeyGenSpeechInput,
  heyGenSpeechInput,
  heyGenGenerationInput,
} from "./external-tools";
import { createGithubGateway } from "./github-gateway.server";
import { createHeyGenClient, HeyGenRequestError, validatedHeyGenAssetUrl } from "./heygen.server";
import { getStorageAllowanceMb } from "./plan.server";
import {
  reserveHeyGenByokAttempt,
  reserveManagedProviderUsage,
  settleProviderUsage,
  getManagedSpendStatus,
  type ProviderUsageReservation,
} from "./provider-budget.server";
import { getMediaBucket, sumR2UserStorageBytes } from "./r2-storage.server";
import { adjustCachedR2UserStorageBytes } from "./r2-usage-cache.server";
import {
  enforceRequestRateLimit,
  readResponseBytes,
  RequestHttpError,
} from "./request-security.server";
import {
  decryptServerSecret,
  encryptServerSecret,
  isServerSecretEncryptionKeyValid,
} from "./secret-crypto.server";
import { resolveWorkspace } from "./workspace-session.server";

const assetPath = "/api/external-tools/heygen/asset";
const maxAssetBytes = 32 * 1024 * 1024;
const fifteenMinutes = 15 * 60_000;

type ExternalAction =
  | "connect"
  | "disconnect"
  | "discover"
  | "account"
  | "catalog"
  | "prepare"
  | "approve"
  | "submit"
  | "poll";
export type ExternalToolActor = { workspaceId: string; authUserId: string; clientId: string };
export type ExternalJobStatus =
  | "awaiting_approval"
  | "approved"
  | "submitting"
  | "queued"
  | "processing"
  | "ready"
  | "failed"
  | "submission_unknown"
  | "revoked"
  | "expired"
  | "asset_unavailable";
type ConnectionRow = {
  id: string;
  workspace_id: string;
  auth_user_id: string;
  provider: ExternalProvider;
  credential_encrypted: string | null;
  revision: string;
  capabilities: string[];
  connected_at: string;
  revoked_at: string | null;
};
type JobRow = {
  id: string;
  workspace_id: string;
  auth_user_id: string;
  connection_id: string | null;
  connection_revision: string;
  client_id: string;
  request_key: string;
  avatar_id: string;
  avatar_name: string;
  voice_id: string;
  voice_name: string;
  script: string;
  requested_seconds: number;
  estimated_usd_per_minute: number;
  status: ExternalJobStatus;
  approved_at: string | null;
  submitted_at: string | null;
  provider_video_id: string | null;
  duration_seconds: number | null;
  asset_key: string | null;
  error_code: string | null;
  refresh_after: string | null;
  asset_attempts: number;
  created_at: string;
  billing_mode?: "byok" | "managed";
  output_kind?: "video" | "audio";
  source_audio_job_id?: string | null;
  provider_audio_url?: string | null;
  speech_words?: Array<{ word: string; start: number; end: number }>;
  usage_reservation_id?: string | null;
  estimated_microusd?: number | null;
};
type GatewayTable<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};
type GatewayDatabase = {
  public: Database["public"] & {
    Tables: {
      external_tool_connections: GatewayTable<ConnectionRow>;
      heygen_generation_jobs: GatewayTable<JobRow>;
      external_tool_audit: GatewayTable<{
        id: string;
        outcome: "started" | "succeeded" | "failed";
      }>;
    };
    Functions: {
      reserve_external_tool_call: {
        Args: {
          p_workspace_id: string;
          p_auth_user_id: string;
          p_provider: ExternalProvider;
          p_action: ExternalAction;
          p_job_id: string | null;
        };
        Returns: string;
      };
    };
  };
};
const db = supabaseAdmin as unknown as SupabaseClient<GatewayDatabase>;

export function externalToolsEnabled() {
  return (
    process.env.BENTO_EXTERNAL_TOOLS_ENABLED === "true" &&
    isServerSecretEncryptionKeyValid(process.env.EXTERNAL_TOOL_ENCRYPTION_KEY)
  );
}

function configured() {
  if (!externalToolsEnabled()) throw new RequestHttpError(503, "External tools are unavailable.");
}

function scopedConnection(actor: ExternalToolActor, provider: ExternalProvider) {
  return db
    .from("external_tool_connections")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .eq("provider", provider)
    .is("revoked_at", null);
}

async function requireConnection(
  actor: ExternalToolActor,
  provider: ExternalProvider,
  revision?: string,
) {
  const { data, error } = await scopedConnection(actor, provider).maybeSingle();
  if (error) throw new Error("The external connection could not be loaded.");
  if (!data?.credential_encrypted || (revision && data.revision !== revision)) {
    throw new RequestHttpError(409, "Connect this provider in the selected Bento workspace.");
  }
  return {
    ...data,
    credential: await decryptServerSecret(data.credential_encrypted, "external-tool"),
  };
}

export async function managedHeyGenConnection(actor: ExternalToolActor, revision?: string) {
  configured();
  const key = process.env.BENTO_MANAGED_HEYGEN_API_KEY?.trim();
  const currentRevision = process.env.BENTO_MANAGED_HEYGEN_REVISION;
  if (
    process.env.BENTO_MANAGED_HEYGEN_ENABLED !== "true" ||
    !key ||
    !z.uuid().safeParse(currentRevision).success ||
    (revision && revision !== currentRevision) ||
    !(await getManagedSpendStatus(actor.workspaceId, { authUserId: actor.authUserId })).eligible
  )
    throw new RequestHttpError(
      403,
      "Managed avatar generation is unavailable or its allowance is exhausted.",
    );
  return { id: null, revision: currentRevision!, credential: key };
}

async function heyGenConnection(actor: ExternalToolActor, billing = "byok", revision?: string) {
  return billing === "managed"
    ? managedHeyGenConnection(actor, revision)
    : requireConnection(actor, "heygen", revision);
}

export async function requireManagedHeyGenAssets(
  actor: ExternalToolActor,
  avatarId?: string,
  voiceId?: string,
) {
  const client = supabaseAdmin as unknown as SupabaseClient<Database>;
  // Asset grants are service-only. A shared provider account never grants access to other creators' clones.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grants = await (client as any)
    .from("managed_heygen_assets")
    .select("asset_type,provider_asset_id")
    .eq("workspace_id", actor.workspaceId)
    .eq("active", true);
  if (grants.error) throw new Error("Managed avatar permissions could not be loaded.");
  const allowed = (type: string, id: string) => {
    const stock = (
      process.env[
        type === "avatar"
          ? "BENTO_MANAGED_HEYGEN_STOCK_AVATARS"
          : "BENTO_MANAGED_HEYGEN_STOCK_VOICES"
      ] || ""
    )
      .split(",")
      .map((id) => id.trim());
    return (
      stock.includes(id) ||
      (grants.data || []).some(
        (grant: { asset_type: string; provider_asset_id: string }) =>
          grant.asset_type === type && grant.provider_asset_id === id,
      )
    );
  };
  if ((avatarId && !allowed("avatar", avatarId)) || (voiceId && !allowed("voice", voiceId)))
    throw new RequestHttpError(403, "Choose an avatar and voice authorized for this workspace.");
  return allowed;
}

export function heyGenSpeechCost(script: string) {
  const rate = Number(process.env.BENTO_HEYGEN_TTS_MICROUSD_PER_1000_CHARS);
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 1_000_000)
    throw new Error("Voice generation pricing is not configured.");
  return Math.max(1, Math.ceil((Array.from(script).length * rate) / 1000));
}

export function managedHeyGenAvatarCost(seconds: number) {
  const rate = Number(process.env.BENTO_HEYGEN_AVATAR_MICROUSD_PER_MINUTE);
  const increment = Number(process.env.BENTO_HEYGEN_AVATAR_BILLING_INCREMENT_SECONDS);
  const minimum = Number(process.env.BENTO_HEYGEN_AVATAR_MINIMUM_SECONDS);
  if (
    !Number.isSafeInteger(rate) ||
    rate < 1 ||
    rate > 100_000_000 ||
    !Number.isSafeInteger(increment) ||
    increment < 1 ||
    increment > 60 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 0 ||
    minimum > 60 ||
    !process.env.BENTO_HEYGEN_AVATAR_MINIMUM_SECONDS ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  )
    throw new Error("Managed avatar pricing and billing increments are not configured.");
  const billableSeconds = Math.ceil(Math.max(seconds, minimum) / increment) * increment;
  return Math.ceil((billableSeconds * rate) / 60 / 10_000) * 10_000;
}

export function heyGenJobCost(
  job: Pick<
    JobRow,
    | "output_kind"
    | "script"
    | "requested_seconds"
    | "estimated_usd_per_minute"
    | "source_audio_job_id"
    | "billing_mode"
  >,
) {
  return job.output_kind === "audio"
    ? heyGenSpeechCost(job.script)
    : job.billing_mode === "managed"
      ? managedHeyGenAvatarCost(job.requested_seconds)
      : Math.round(
          heyGenEstimateUsd(
            job.source_audio_job_id
              ? job.requested_seconds
              : heyGenEstimateRenderSeconds(job.requested_seconds, job.script),
            job.estimated_usd_per_minute,
          ) * 1_000_000,
        );
}

async function audit<T>(
  actor: ExternalToolActor,
  provider: ExternalProvider,
  action: ExternalAction,
  run: () => Promise<T>,
  jobId: string | null = null,
) {
  configured();
  if (action === "submit" && (provider !== "heygen" || !jobId)) {
    throw new Error("A HeyGen job is required for usage reservation.");
  }
  const { data: id, error } =
    action === "submit" && jobId
      ? await reserveHeyGenByokAttempt({
          workspaceId: actor.workspaceId,
          authUserId: actor.authUserId,
          jobId,
          client: db,
        })
      : await db.rpc("reserve_external_tool_call", {
          p_workspace_id: actor.workspaceId,
          p_auth_user_id: actor.authUserId,
          p_provider: provider,
          p_action: action,
          p_job_id: jobId,
        });
  if (error) throw new RequestHttpError(503, "External tool controls are unavailable.");
  if (!id)
    throw new RequestHttpError(429, "External tool usage limit reached or workspace unavailable.");
  let outcome: "succeeded" | "failed" = "failed";
  try {
    const result = await run();
    outcome = "succeeded";
    return result;
  } finally {
    try {
      const result = await db.from("external_tool_audit").update({ outcome }).eq("id", id);
      if (result.error) console.warn("external_tool_audit_update_failed", { id, provider, action });
    } catch {
      console.warn("external_tool_audit_update_failed", { id, provider, action });
    }
  }
}

export async function getExternalConnections(actor: ExternalToolActor) {
  if (!externalToolsEnabled()) return { enabled: false, connections: [] };
  const { data, error } = await db
    .from("external_tool_connections")
    .select("provider,capabilities,connected_at")
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .is("revoked_at", null);
  if (error) throw new Error("External connections could not be loaded.");
  return {
    enabled: true,
    connections: (data ?? []).map((row) => ({
      provider: row.provider,
      capabilities: row.capabilities,
      connectedAt: row.connected_at,
    })),
  };
}

export function connectExternalTool(
  actor: ExternalToolActor,
  input: z.infer<typeof externalCredentialSchema>,
) {
  if (actor.clientId !== "bento-browser") throw new RequestHttpError(403, "Connect in Bento.");
  return audit(actor, input.provider, "connect", async () => {
    const repository = input.githubRepository;
    const capabilities =
      input.provider === "github_mcp"
        ? await createGithubGateway(input.credential, fetch, Boolean(repository))
            .discover()
            .then((tools) =>
              tools.map((tool) => (tool === "pull_request_read" ? `${tool}:${repository}` : tool)),
            )
        : await createHeyGenClient(input.credential)
            .verifyCredential()
            .then(() => [...externalToolNames.heygen]);
    const encrypted = await encryptServerSecret(input.credential, "external-tool");
    const { error } = await db.from("external_tool_connections").upsert(
      {
        workspace_id: actor.workspaceId,
        auth_user_id: actor.authUserId,
        provider: input.provider,
        credential_encrypted: encrypted,
        revision: crypto.randomUUID(),
        capabilities,
        connected_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "workspace_id,auth_user_id,provider" },
    );
    if (error) throw new Error("The external connection could not be saved.");
    return { provider: input.provider, capabilities };
  });
}

export function disconnectExternalTool(actor: ExternalToolActor, provider: ExternalProvider) {
  if (actor.clientId !== "bento-browser") throw new RequestHttpError(403, "Disconnect in Bento.");
  return audit(actor, provider, "disconnect", async () => {
    const { error } = await db
      .from("external_tool_connections")
      .update({
        credential_encrypted: null,
        revoked_at: new Date().toISOString(),
        revision: crypto.randomUUID(),
        capabilities: [],
      })
      .eq("workspace_id", actor.workspaceId)
      .eq("auth_user_id", actor.authUserId)
      .eq("provider", provider)
      .is("revoked_at", null);
    if (error) throw new Error("The external connection could not be disconnected.");
    return { provider };
  });
}

export function readGithubAccount(actor: ExternalToolActor) {
  return audit(actor, "github_mcp", "account", async () => {
    const { credential, capabilities } = await requireConnection(actor, "github_mcp");
    if (!capabilities.includes("get_me")) throw new RequestHttpError(409, "Reconnect GitHub MCP.");
    return createGithubGateway(credential).account();
  });
}

export function readGithubPullRequest(
  actor: ExternalToolActor,
  input: z.infer<typeof githubPullRequestSchema>,
) {
  return audit(actor, "github_mcp", "catalog", async () => {
    const current = await requireConnection(actor, "github_mcp");
    if (!current.capabilities.includes(`pull_request_read:${input.repository}`))
      throw new RequestHttpError(
        403,
        "Allow this repository in Bento's GitHub MCP settings first.",
      );
    const result = await createGithubGateway(current.credential, fetch, true).pullRequest(input);
    // Read only the current grant. A rotation or revoke during the upstream request discards the result.
    const { data, error } = await scopedConnection(actor, "github_mcp")
      .eq("revision", current.revision)
      .maybeSingle();
    if (error || !data) throw new RequestHttpError(409, "The GitHub MCP connection changed.");
    return result;
  });
}

export function listHeyGenAvatarsFor(actor: ExternalToolActor, input: HeyGenCatalogInput) {
  return audit(actor, "heygen", "catalog", async () => {
    const { credential } = await heyGenConnection(actor, input.billing);
    const page = await createHeyGenClient(credential).avatars(input);
    if (input.billing === "managed") {
      const allowed = await requireManagedHeyGenAssets(actor);
      page.avatars = page.avatars.filter((avatar) => allowed("avatar", avatar.id));
    }
    return page;
  });
}

export function listHeyGenVoicesFor(actor: ExternalToolActor, input: HeyGenCatalogInput) {
  return audit(actor, "heygen", "catalog", async () => {
    const { credential } = await heyGenConnection(actor, input.billing);
    const page = await createHeyGenClient(credential).voices(input);
    if (input.billing === "managed") {
      const allowed = await requireManagedHeyGenAssets(actor);
      page.voices = page.voices.filter((voice) => allowed("voice", voice.id));
    }
    return page;
  });
}

function scopedJob(actor: ExternalToolActor, jobId: string) {
  return db
    .from("heygen_generation_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId);
}

async function getJob(actor: ExternalToolActor, jobId: string) {
  configured();
  const { data, error } = await scopedJob(actor, jobId).maybeSingle();
  if (error) throw new Error("The HeyGen generation could not be loaded.");
  if (!data || (actor.clientId !== "bento-browser" && actor.clientId !== data.client_id)) {
    throw new RequestHttpError(404, "HeyGen generation unavailable.");
  }
  return data;
}

async function updateJob(job: JobRow, fields: Partial<JobRow>, checkRefresh = false) {
  let query = db
    .from("heygen_generation_jobs")
    .update(fields)
    .eq("id", job.id)
    .eq("workspace_id", job.workspace_id)
    .eq("auth_user_id", job.auth_user_id)
    .eq("status", job.status);
  if (checkRefresh) {
    query = job.refresh_after
      ? query.eq("refresh_after", job.refresh_after)
      : query.is("refresh_after", null);
  }
  const { data, error } = await query.select().maybeSingle();
  if (error) throw new Error("The HeyGen generation could not be updated.");
  return data;
}

const assetGrantSchema = z.object({
  jobId: z.uuid(),
  workspaceId: z.uuid(),
  authUserId: z.uuid(),
  expiresAt: z.number(),
  purpose: z.enum(["preview", "provider_input"]).optional(),
});

function assetKey(job: Pick<JobRow, "workspace_id" | "id" | "output_kind">) {
  return `private/users/${job.workspace_id}/heygen/${job.id}.${job.output_kind === "audio" ? "wav" : "mp4"}`;
}

async function publicJob(job: JobRow) {
  const grant =
    job.asset_key === assetKey(job)
      ? await encryptServerSecret(
          JSON.stringify({
            jobId: job.id,
            workspaceId: job.workspace_id,
            authUserId: job.auth_user_id,
            expiresAt: Date.now() + fifteenMinutes,
          }),
          "external-tool",
        )
      : null;
  const estimatedRenderSeconds = job.source_audio_job_id
    ? job.requested_seconds
    : heyGenEstimateRenderSeconds(job.requested_seconds, job.script);
  const estimatedMicrousd =
    job.estimated_microusd && !["awaiting_approval", "approved"].includes(job.status)
      ? job.estimated_microusd
      : heyGenJobCost(job);
  return {
    jobId: job.id,
    status: job.status,
    avatarId: job.avatar_id,
    avatarName: job.avatar_name,
    voiceId: job.voice_id,
    voiceName: job.voice_name,
    script: job.script,
    requestedSeconds: job.requested_seconds,
    model: job.output_kind === "audio" ? "HeyGen Voice 1 · audio" : HEYGEN_MODEL_DESCRIPTION,
    billing:
      job.billing_mode === "managed"
        ? ("bento_managed" as const)
        : ("your_heygen_account" as const),
    outputKind: job.output_kind ?? "video",
    speechWords: job.speech_words ?? [],
    sourceAudioJobId: job.source_audio_job_id ?? null,
    estimatedRenderSeconds,
    estimatedUsd:
      job.output_kind === "audio" || job.billing_mode === "managed"
        ? estimatedMicrousd / 1_000_000
        : heyGenEstimateUsd(estimatedRenderSeconds, job.estimated_usd_per_minute),
    estimatedMicrousd,
    durationSeconds: job.duration_seconds,
    assetKey: grant ? job.asset_key : null,
    assetUrl: grant ? `${assetPath}?grant=${encodeURIComponent(grant)}` : null,
    approvalPath:
      job.status === "awaiting_approval"
        ? `/mcp?heygenJob=${job.id}&heygenWorkspace=${job.workspace_id}`
        : null,
    refreshAfter: job.refresh_after,
    errorCode: job.error_code,
  };
}

export type ExternalHeyGenJob = Awaited<ReturnType<typeof publicJob>>;

export async function prepareHeyGenJob(actor: ExternalToolActor, input: HeyGenGenerationInput) {
  input = heyGenGenerationInput.parse(input);
  configured();
  if (input.billing === "managed" && !input.sourceAudioJobId)
    throw new Error("Prepare narration before generating managed avatar footage.");
  if (input.billing === "managed")
    await requireManagedHeyGenAssets(actor, input.avatarId, input.voiceId);
  if (input.sourceAudioJobId) {
    const audio = await getJob(actor, input.sourceAudioJobId);
    if (
      audio.output_kind !== "audio" ||
      audio.status !== "ready" ||
      !audio.duration_seconds ||
      audio.voice_id !== input.voiceId ||
      audio.script !== input.script ||
      Math.ceil(audio.duration_seconds) !== input.requestedSeconds ||
      (audio.billing_mode ?? "byok") !== (input.billing ?? "byok")
    )
      throw new Error("Use the matching ready narration for this avatar scene.");
  }
  async function findExisting() {
    const { data, error } = await db
      .from("heygen_generation_jobs")
      .select("*")
      .eq("workspace_id", actor.workspaceId)
      .eq("auth_user_id", actor.authUserId)
      .eq("client_id", actor.clientId)
      .eq("request_key", input.requestKey)
      .maybeSingle();
    if (error) throw new Error("The HeyGen generation could not be loaded.");
    if (
      data &&
      (data.avatar_id !== input.avatarId ||
        data.voice_id !== input.voiceId ||
        data.script !== input.script ||
        data.requested_seconds !== input.requestedSeconds ||
        (data.billing_mode ?? "byok") !== (input.billing ?? "byok") ||
        (data.source_audio_job_id ?? null) !== (input.sourceAudioJobId ?? null))
    ) {
      throw new RequestHttpError(409, "Use a new request key after changing the generation.");
    }
    return data;
  }
  const existing = await findExisting();
  if (existing) return publicJob(existing);
  return audit(actor, "heygen", "prepare", async () => {
    const connection = await heyGenConnection(actor, input.billing);
    const { avatar, voice } = await createHeyGenClient(connection.credential).selection(
      input.avatarId,
      input.voiceId,
    );
    const cost =
      input.billing === "managed" ? managedHeyGenAvatarCost(input.requestedSeconds) : null;
    if (cost && cost > 1_000_000)
      throw new Error("Use a shorter avatar segment to fit the managed per-generation limit.");
    const { data, error } = await db
      .from("heygen_generation_jobs")
      .insert({
        workspace_id: actor.workspaceId,
        auth_user_id: actor.authUserId,
        client_id: actor.clientId,
        connection_id: connection.id,
        connection_revision: connection.revision,
        request_key: input.requestKey,
        avatar_id: avatar.id,
        avatar_name: avatar.name,
        voice_id: voice.id,
        voice_name: voice.name,
        script: input.script,
        requested_seconds: input.requestedSeconds,
        estimated_usd_per_minute: avatar.estimatedUsdPerMinute,
        billing_mode: input.billing ?? "byok",
        source_audio_job_id: input.sourceAudioJobId ?? null,
        estimated_microusd: cost,
      })
      .select()
      .single();
    if (data) return publicJob(data);
    if (error?.code === "23505") {
      const duplicate = await findExisting();
      if (duplicate) return publicJob(duplicate);
    }
    throw new Error("The HeyGen generation could not be prepared.");
  });
}

export async function approveHeyGenJob(actor: ExternalToolActor, jobId: string) {
  if (actor.clientId !== "bento-browser")
    throw new RequestHttpError(403, "Review this generation in Bento.");
  const job = await getJob(actor, jobId);
  if (job.status !== "awaiting_approval") return publicJob(job);
  if (Date.now() - Date.parse(job.created_at) > 2 * fifteenMinutes) {
    return publicJob((await updateJob(job, { status: "expired" })) ?? (await getJob(actor, jobId)));
  }
  return audit(
    actor,
    "heygen",
    "approve",
    async () => {
      await heyGenConnection(actor, job.billing_mode, job.connection_revision);
      const approved = await updateJob(job, {
        status: "approved",
        approved_at: new Date().toISOString(),
      });
      return publicJob(approved ?? (await getJob(actor, jobId)));
    },
    jobId,
  );
}

export async function prepareHeyGenSpeechJob(
  actor: ExternalToolActor,
  input: HeyGenSpeechInput,
): Promise<ExternalHeyGenJob> {
  input = heyGenSpeechInput.parse(input);
  configured();
  if (input.billing === "managed")
    await requireManagedHeyGenAssets(actor, undefined, input.voiceId);
  heyGenSpeechCost(input.script); // No paid fallback without a configured conservative price.
  const { data: existing, error } = await db
    .from("heygen_generation_jobs")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .eq("auth_user_id", actor.authUserId)
    .eq("client_id", actor.clientId)
    .eq("request_key", input.requestKey)
    .maybeSingle();
  if (error) throw new Error("Voice generation could not be loaded.");
  if (existing) {
    if (
      existing.output_kind !== "audio" ||
      existing.script !== input.script ||
      existing.voice_id !== input.voiceId ||
      existing.requested_seconds !== input.requestedSeconds ||
      (existing.billing_mode ?? "byok") !== (input.billing ?? "byok")
    )
      throw new RequestHttpError(409, "Use a new request key after changing narration.");
    return publicJob(existing);
  }
  return audit(actor, "heygen", "prepare", async () => {
    const connection = await heyGenConnection(actor, input.billing);
    const voice = await createHeyGenClient(connection.credential).voice(input.voiceId);
    const { data, error } = await db
      .from("heygen_generation_jobs")
      .insert({
        workspace_id: actor.workspaceId,
        auth_user_id: actor.authUserId,
        client_id: actor.clientId,
        connection_id: connection.id,
        connection_revision: connection.revision,
        request_key: input.requestKey,
        avatar_id: "voiceover",
        avatar_name: "Narration",
        voice_id: voice.id,
        voice_name: voice.name,
        script: input.script,
        requested_seconds: input.requestedSeconds,
        estimated_usd_per_minute: 0.01,
        output_kind: "audio",
        billing_mode: input.billing ?? "byok",
        estimated_microusd: heyGenSpeechCost(input.script),
      })
      .select()
      .single();
    if (error?.code === "23505") {
      const duplicate = await db
        .from("heygen_generation_jobs")
        .select("*")
        .eq("workspace_id", actor.workspaceId)
        .eq("auth_user_id", actor.authUserId)
        .eq("client_id", actor.clientId)
        .eq("request_key", input.requestKey)
        .maybeSingle();
      if (
        !duplicate.error &&
        duplicate.data &&
        duplicate.data.output_kind === "audio" &&
        duplicate.data.script === input.script &&
        duplicate.data.voice_id === input.voiceId &&
        duplicate.data.requested_seconds === input.requestedSeconds &&
        (duplicate.data.billing_mode ?? "byok") === (input.billing ?? "byok")
      )
        return publicJob(duplicate.data);
    }
    if (error || !data) throw new Error("Narration could not be prepared.");
    return publicJob(data);
  });
}

export async function startHeyGenJob(actor: ExternalToolActor, jobId: string) {
  const job = await getJob(actor, jobId);
  if (job.status === "awaiting_approval")
    throw new RequestHttpError(409, "Review and approve this generation in Bento first.");
  if (job.status !== "approved") return publicJob(job);
  if (!job.approved_at || Date.now() - Date.parse(job.approved_at) > fifteenMinutes) {
    return publicJob((await updateJob(job, { status: "expired" })) ?? (await getJob(actor, jobId)));
  }
  return audit(
    actor,
    "heygen",
    "submit",
    async () => {
      const claimed = await updateJob(job, {
        status: "submitting",
        submitted_at: new Date().toISOString(),
      });
      if (!claimed) return publicJob(await getJob(actor, jobId));
      let credential: string;
      try {
        ({ credential } = await heyGenConnection(actor, job.billing_mode, job.connection_revision));
        if (job.billing_mode === "managed")
          await requireManagedHeyGenAssets(
            actor,
            job.output_kind === "audio" ? undefined : job.avatar_id,
            job.voice_id,
          );
      } catch (error) {
        await updateJob(claimed, { status: "revoked", error_code: "connection_unavailable" });
        throw error;
      }
      let providerId: string;
      let reservation: ProviderUsageReservation | undefined;
      try {
        if (job.billing_mode === "managed") {
          reservation = await reserveManagedProviderUsage({
            workspaceId: actor.workspaceId,
            authUserId: actor.authUserId,
            attemptId: job.id,
            provider: "heygen",
            model: job.output_kind === "audio" ? "heygen-voice-1" : "avatar_iv",
            units: heyGenJobCost(job),
          });
          const saved = await updateJob(claimed, {
            usage_reservation_id: reservation.id,
            estimated_microusd: reservation.units,
          });
          if (!saved) throw new Error("Generation usage could not be recorded.");
          Object.assign(claimed, saved);
        }
      } catch (error) {
        await updateJob(claimed, { status: "approved", submitted_at: null });
        throw error; // Never execute a provider when the reservation is denied.
      }
      try {
        if (job.output_kind === "audio") {
          const speech = await createHeyGenClient(credential).speech({
            jobId: claimed.id,
            voiceId: job.voice_id,
            script: job.script,
          });
          const pending = await updateJob(claimed, {
            status: "processing",
            duration_seconds: speech.duration,
            provider_audio_url: speech.audio_url,
            speech_words: speech.original_words ?? [],
            refresh_after: null,
          });
          if (!pending) throw new Error("Narration response needs review.");
          await settleProviderUsage(reservation, reservation?.units ?? 0);
          return pollHeyGenJob(actor, pending.id);
        }
        let audioUrl: string | undefined;
        if (job.source_audio_job_id) {
          const audio = await getJob(actor, job.source_audio_job_id);
          if (
            audio.status !== "ready" ||
            audio.output_kind !== "audio" ||
            audio.asset_key !== assetKey(audio)
          )
            throw new Error("Narration is no longer available.");
          const origin = new URL(process.env.VITE_APP_URL || "http://localhost:8080");
          if (origin.protocol !== "https:") throw new Error("Configure a secure narration origin.");
          const grant = await encryptServerSecret(
            JSON.stringify({
              jobId: audio.id,
              workspaceId: audio.workspace_id,
              authUserId: audio.auth_user_id,
              expiresAt: Date.now() + 2 * 60 * 60_000,
              purpose: "provider_input",
            }),
            "external-tool",
          );
          audioUrl = new URL(`${assetPath}?grant=${encodeURIComponent(grant)}`, origin).href;
        }
        providerId = await createHeyGenClient(credential).submit({
          jobId: claimed.id,
          avatarId: claimed.avatar_id,
          voiceId: claimed.voice_id,
          script: claimed.script,
          audioUrl,
        });
      } catch (error) {
        const rejected =
          error instanceof HeyGenRequestError &&
          [400, 401, 403, 404, 422, 429].includes(error.status);
        await updateJob(claimed, {
          status: rejected ? "failed" : "submission_unknown",
          error_code: rejected ? "provider_rejected" : "provider_confirmation_missing",
        });
        throw error;
      }
      const submitted = await updateJob(claimed, {
        status: "queued",
        provider_video_id: providerId,
        refresh_after: new Date(Date.now() + 10_000).toISOString(),
      });
      if (!submitted) throw new Error("The generation response needs review in HeyGen.");
      await settleProviderUsage(reservation, reservation?.units ?? 0);
      return publicJob(submitted);
    },
    jobId,
  );
}

async function storeHeyGenAsset(job: JobRow, providerUrl?: string | null) {
  const source = validatedHeyGenAssetUrl(providerUrl);
  if (!source) throw new Error("HeyGen returned an unsupported asset URL.");
  const bucket = getMediaBucket();
  const key = assetKey(job);
  if (await bucket.head(key)) return key;
  const response = await fetch(source, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("HeyGen video download failed.");
  }
  const bytes = await readResponseBytes(response, maxAssetBytes);
  const decoder = new TextDecoder();
  const audio = job.output_kind === "audio";
  if (
    bytes.byteLength < 16 ||
    (audio
      ? decoder.decode(bytes.subarray(0, 4)) !== "RIFF" ||
        decoder.decode(bytes.subarray(8, 12)) !== "WAVE"
      : decoder.decode(bytes.subarray(4, 8)) !== "ftyp")
  ) {
    throw new Error("The generation did not return supported media.");
  }
  const [current, allowance] = await Promise.all([
    sumR2UserStorageBytes(bucket, job.workspace_id),
    getStorageAllowanceMb(job.workspace_id),
  ]);
  if (current + bytes.byteLength > allowance * 1024 * 1024)
    throw new Error("Workspace storage is full.");
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: audio ? "audio/wav" : "video/mp4",
      cacheControl: "private, no-store",
    },
  });
  await adjustCachedR2UserStorageBytes(job.workspace_id, bytes.byteLength).catch(() => {
    console.warn("heygen_asset_usage_update_failed", { jobId: job.id });
  });
  return key;
}

export async function readHeyGenJob(actor: ExternalToolActor, jobId: string) {
  const job = await getJob(actor, jobId);
  if (
    job.status === "submitting" &&
    job.submitted_at &&
    Date.now() - Date.parse(job.submitted_at) > 120_000
  ) {
    return publicJob(
      (await updateJob(job, {
        status: "submission_unknown",
        error_code: "provider_confirmation_missing",
      })) ?? (await getJob(actor, jobId)),
    );
  }
  return publicJob(job);
}

export async function pollHeyGenJob(actor: ExternalToolActor, jobId: string) {
  const job = await getJob(actor, jobId);
  if (job.output_kind === "audio" && job.status === "processing" && job.provider_audio_url) {
    if (job.refresh_after && Date.parse(job.refresh_after) > Date.now()) return publicJob(job);
    const claimed = await updateJob(
      job,
      { refresh_after: new Date(Date.now() + 45_000).toISOString() },
      true,
    );
    if (!claimed) return readHeyGenJob(actor, jobId);
    try {
      await heyGenConnection(actor, job.billing_mode, job.connection_revision);
      const key = await storeHeyGenAsset(claimed, claimed.provider_audio_url);
      return publicJob(
        (await updateJob(
          claimed,
          {
            status: "ready",
            asset_key: key,
            provider_audio_url: null,
            refresh_after: null,
            error_code: null,
          },
          true,
        )) ?? (await getJob(actor, jobId)),
      );
    } catch {
      const attempts = claimed.asset_attempts + 1;
      return publicJob(
        (await updateJob(
          claimed,
          {
            status: attempts >= 3 ? "asset_unavailable" : "processing",
            asset_attempts: attempts,
            error_code: "asset_import_failed",
          },
          true,
        )) ?? claimed,
      );
    }
  }
  if (
    !job.provider_video_id ||
    !["queued", "processing"].includes(job.status) ||
    (job.refresh_after && Date.parse(job.refresh_after) > Date.now())
  )
    return readHeyGenJob(actor, jobId);
  const providerVideoId = job.provider_video_id;
  // A durable lease prevents concurrent status checks and R2 imports across Workers.
  const claimed = await updateJob(
    job,
    { refresh_after: new Date(Date.now() + 45_000).toISOString() },
    true,
  );
  if (!claimed) return readHeyGenJob(actor, jobId);
  return audit(
    actor,
    "heygen",
    "poll",
    async () => {
      let credential: string;
      try {
        ({ credential } = await heyGenConnection(actor, job.billing_mode, job.connection_revision));
      } catch (error) {
        if (error instanceof RequestHttpError && error.statusCode === 409) {
          return publicJob(
            (await updateJob(claimed, { status: "revoked", refresh_after: null }, true)) ?? claimed,
          );
        }
        throw error;
      }
      const status = await createHeyGenClient(credential).status(providerVideoId);
      if (status.status === "completed") {
        try {
          const key = await storeHeyGenAsset(claimed, status.video_url);
          const ready = await updateJob(
            claimed,
            {
              status: "ready",
              duration_seconds: status.duration ?? null,
              asset_key: key,
              refresh_after: null,
              error_code: null,
            },
            true,
          );
          return publicJob(ready ?? (await getJob(actor, jobId)));
        } catch {
          const attempts = claimed.asset_attempts + 1;
          const failed = await updateJob(
            claimed,
            {
              status: attempts >= 3 ? "asset_unavailable" : "processing",
              asset_attempts: attempts,
              error_code: "asset_import_failed",
              refresh_after: attempts >= 3 ? null : claimed.refresh_after,
            },
            true,
          );
          return publicJob(failed ?? (await getJob(actor, jobId)));
        }
      }
      const next = await updateJob(
        claimed,
        {
          status:
            status.status === "failed"
              ? "failed"
              : status.status === "pending"
                ? "queued"
                : "processing",
          error_code: status.status === "failed" ? "provider_generation_failed" : null,
          refresh_after:
            status.status === "failed" ? null : new Date(Date.now() + 15_000).toISOString(),
        },
        true,
      );
      return publicJob(next ?? (await getJob(actor, jobId)));
    },
    jobId,
  );
}

function byteRange(header: string, size: number) {
  const match = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const offset = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return offset <= last && offset < size ? { offset, length: last - offset + 1 } : null;
}

export async function handleHeyGenAssetRequest(request: Request) {
  const notFound = () =>
    new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!externalToolsEnabled()) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const token = new URL(request.url).searchParams.get("grant");
  if (!token || token.length > 1000) return notFound();
  try {
    await enforceRequestRateLimit(
      "PUBLIC_API_RATE_LIMITER",
      "heygen-asset-ip",
      request.headers.get("cf-connecting-ip") || "missing-cloudflare-ip",
    );
  } catch (error) {
    return new Response("Temporarily unavailable", {
      status: error instanceof RequestHttpError ? error.statusCode : 503,
    });
  }

  let grant: z.infer<typeof assetGrantSchema>;
  try {
    grant = assetGrantSchema.parse(JSON.parse(await decryptServerSecret(token, "external-tool")));
  } catch {
    return notFound();
  }
  if (grant.expiresAt < Date.now()) return notFound();
  try {
    await enforceRequestRateLimit(
      "PUBLIC_API_RATE_LIMITER",
      "heygen-asset-member",
      grant.authUserId,
    );
    const session = await resolveWorkspace(grant.authUserId, grant.workspaceId);
    if (session.workspaceId !== grant.workspaceId || session.workspace.status !== "active")
      return notFound();
    const job = await getJob({ ...grant, clientId: "bento-browser" }, grant.jobId);
    if (grant.purpose === "provider_input") {
      const actor = { ...grant, clientId: "bento-browser" };
      await heyGenConnection(actor, job.billing_mode, job.connection_revision);
      if (job.billing_mode === "managed")
        await requireManagedHeyGenAssets(actor, undefined, job.voice_id);
    }
    const key = assetKey(job);
    if (job.status !== "ready" || job.asset_key !== key) return notFound();
    const bucket = getMediaBucket();
    const object = await bucket.head(key);
    if (!object || object.size > maxAssetBytes) return notFound();
    const headers = new Headers({
      "content-type": job.output_kind === "audio" ? "audio/wav" : "video/mp4",
      "cache-control": "private, no-store",
      "accept-ranges": "bytes",
      "content-length": String(object.size),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") return new Response(null, { headers });
    const requested = request.headers.get("range");
    const range = requested ? byteRange(requested, object.size) : null;
    if (requested && !range) {
      headers.set("content-range", `bytes */${object.size}`);
      headers.delete("content-length");
      return new Response(null, { status: 416, headers });
    }
    const result = await bucket.get(key, range ? { range } : undefined);
    if (!result) return notFound();
    if (range) {
      headers.set(
        "content-range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
      );
      headers.set("content-length", String(range.length));
    }
    return new Response(result.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof RequestHttpError && [429, 503].includes(error.statusCode)) {
      return new Response("Temporarily unavailable", {
        status: error.statusCode,
        headers: { "cache-control": "no-store" },
      });
    }
    return notFound();
  }
}
