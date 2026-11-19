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
} from "./external-tools";
import { createGithubGateway } from "./github-gateway.server";
import { createHeyGenClient, HeyGenRequestError, validatedHeyGenAssetUrl } from "./heygen.server";
import { getStorageAllowanceMb } from "./plan.server";
import { reserveHeyGenByokAttempt } from "./provider-budget.server";
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
  connection_id: string;
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
    const { credential } = await requireConnection(actor, "heygen");
    return createHeyGenClient(credential).avatars(input);
  });
}

export function listHeyGenVoicesFor(actor: ExternalToolActor, input: HeyGenCatalogInput) {
  return audit(actor, "heygen", "catalog", async () => {
    const { credential } = await requireConnection(actor, "heygen");
    return createHeyGenClient(credential).voices(input);
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
});

function assetKey(job: Pick<JobRow, "workspace_id" | "id">) {
  return `private/users/${job.workspace_id}/heygen/${job.id}.mp4`;
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
  const estimatedRenderSeconds = heyGenEstimateRenderSeconds(job.requested_seconds, job.script);
  return {
    jobId: job.id,
    status: job.status,
    avatarId: job.avatar_id,
    avatarName: job.avatar_name,
    voiceId: job.voice_id,
    voiceName: job.voice_name,
    script: job.script,
    requestedSeconds: job.requested_seconds,
    model: HEYGEN_MODEL_DESCRIPTION,
    billing: "your_heygen_account" as const,
    estimatedRenderSeconds,
    estimatedUsd: heyGenEstimateUsd(estimatedRenderSeconds, job.estimated_usd_per_minute),
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
  configured();
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
        data.requested_seconds !== input.requestedSeconds)
    ) {
      throw new RequestHttpError(409, "Use a new request key after changing the generation.");
    }
    return data;
  }
  const existing = await findExisting();
  if (existing) return publicJob(existing);
  return audit(actor, "heygen", "prepare", async () => {
    const connection = await requireConnection(actor, "heygen");
    const { avatar, voice } = await createHeyGenClient(connection.credential).selection(
      input.avatarId,
      input.voiceId,
    );
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
      await requireConnection(actor, "heygen", job.connection_revision);
      const approved = await updateJob(job, {
        status: "approved",
        approved_at: new Date().toISOString(),
      });
      return publicJob(approved ?? (await getJob(actor, jobId)));
    },
    jobId,
  );
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
        ({ credential } = await requireConnection(actor, "heygen", job.connection_revision));
      } catch (error) {
        await updateJob(claimed, { status: "revoked", error_code: "connection_unavailable" });
        throw error;
      }
      let providerId: string;
      try {
        providerId = await createHeyGenClient(credential).submit({
          jobId: claimed.id,
          avatarId: claimed.avatar_id,
          voiceId: claimed.voice_id,
          script: claimed.script,
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
  const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("HeyGen video download failed.");
  }
  const bytes = await readResponseBytes(response, maxAssetBytes);
  if (bytes.byteLength < 16 || new TextDecoder().decode(bytes.subarray(4, 8)) !== "ftyp") {
    throw new Error("HeyGen did not return a supported MP4.");
  }
  const [current, allowance] = await Promise.all([
    sumR2UserStorageBytes(bucket, job.workspace_id),
    getStorageAllowanceMb(job.workspace_id),
  ]);
  if (current + bytes.byteLength > allowance * 1024 * 1024)
    throw new Error("Workspace storage is full.");
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "video/mp4", cacheControl: "private, no-store" },
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
        ({ credential } = await requireConnection(actor, "heygen", job.connection_revision));
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
    const key = assetKey(job);
    if (job.status !== "ready" || job.asset_key !== key) return notFound();
    const bucket = getMediaBucket();
    const object = await bucket.head(key);
    if (!object || object.size > maxAssetBytes) return notFound();
    const headers = new Headers({
      "content-type": "video/mp4",
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
