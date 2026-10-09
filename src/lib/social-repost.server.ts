/* eslint-disable @typescript-eslint/no-explicit-any -- Repost table lands with the paired migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPlan } from "./plan.server";
import { planHasEntitlement } from "./plans";
import { socialRetryDelaySeconds, type SocialProvider } from "./social-scheduler";
import {
  accessTokenForConnection,
  providerJson,
  ProviderError,
  socialPublishQueueBinding,
} from "./social-publisher.server";

export type SocialRepostMessage = {
  kind: "social_repost";
  targetId: string;
  action: "repost" | "remove";
};

function queueForProvider(env: unknown, provider: SocialProvider) {
  const bindings = (env || {}) as Record<string, Queue<SocialRepostMessage> | undefined>;
  return bindings[socialPublishQueueBinding(provider)] || bindings.SOCIAL_PUBLISH_QUEUE;
}

export async function enqueueDueSocialReposts(env: unknown) {
  const db = supabaseAdmin as any;
  const { data, error } = await db.rpc("claim_due_social_repost_jobs", {
    claim_limit: 50,
    lease_seconds: 300,
  });
  if (error) throw error;
  let queued = 0;
  for (const job of data || []) {
    const action = job.job_phase === "remove_queued" ? "remove" : "repost";
    const queue = queueForProvider(env, job.job_provider as SocialProvider);
    try {
      if (!queue) throw new Error("Social publishing queue is unavailable.");
      await queue.send({ kind: "social_repost", targetId: job.job_target_id, action });
      queued += 1;
    } catch {
      await db
        .from("social_repost_jobs")
        .update({
          phase: action === "remove" ? "reposted" : "pending",
          lease_expires_at: null,
        })
        .eq("target_id", job.job_target_id)
        .eq("phase", job.job_phase);
    }
  }
  return { queued };
}

function linkedInHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
    "LinkedIn-Version": process.env.LINKEDIN_API_VERSION?.trim() || "202606",
  };
}

export async function createNativeRepost(
  provider: "linkedin" | "twitter",
  connection: any,
  originalPostId: string,
  accessToken?: string,
) {
  const token = accessToken ?? (await accessTokenForConnection(connection));
  if (provider === "twitter") {
    const { data } = await providerJson(
      `https://api.x.com/2/users/${encodeURIComponent(connection.provider_user_id)}/retweets`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tweet_id: originalPostId }),
      },
      "twitter",
    );
    if (data.data?.retweeted !== true) {
      throw new ProviderError("X did not confirm the repost.", "repost_unconfirmed", false);
    }
    return originalPostId;
  }
  const { data, response } = await providerJson(
    "https://api.linkedin.com/rest/posts",
    {
      method: "POST",
      headers: linkedInHeaders(token),
      body: JSON.stringify({
        author: connection.provider_user_id,
        commentary: "",
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        reshareContext: { parent: originalPostId },
      }),
    },
    "linkedin",
  );
  const repostId = String(response.headers.get("x-restli-id") || data.id || "");
  if (!repostId) {
    throw new ProviderError(
      "LinkedIn may have reposted this post, but did not return its ID. Check LinkedIn before retrying.",
      "outcome_unknown",
      false,
    );
  }
  return repostId;
}

export async function removeNativeRepost(
  provider: "linkedin" | "twitter",
  connection: any,
  originalPostId: string,
  repostId: string,
) {
  const token = await accessTokenForConnection(connection);
  if (provider === "twitter") {
    const { data } = await providerJson(
      `https://api.x.com/2/users/${encodeURIComponent(connection.provider_user_id)}/retweets/${encodeURIComponent(originalPostId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      "twitter",
    );
    if (data.data?.retweeted !== false) {
      throw new ProviderError(
        "X did not confirm removal of the repost.",
        "remove_unconfirmed",
        true,
      );
    }
    return;
  }
  await providerJson(
    `https://api.linkedin.com/rest/posts/${encodeURIComponent(repostId)}`,
    {
      method: "DELETE",
      headers: { ...linkedInHeaders(token), "X-RestLi-Method": "DELETE" },
    },
    "linkedin",
  );
}

export async function processSocialRepostMessage(message: SocialRepostMessage) {
  const db = supabaseAdmin as any;
  const { data: job, error } = await db
    .from("social_repost_jobs")
    .select("*")
    .eq("target_id", message.targetId)
    .maybeSingle();
  if (error) throw error;
  const queuedPhase = message.action === "repost" ? "repost_queued" : "remove_queued";
  const workingPhase = message.action === "repost" ? "reposting" : "removing";
  if (!job || job.phase !== queuedPhase) return;
  const { data: target, error: targetError } = await db
    .from("social_post_targets")
    .select(
      "id, provider, status, post_id, connection_id, remote_post_id, post:social_posts(user_id), connection:social_connections(*)",
    )
    .eq("id", message.targetId)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target || target.status !== "published" || !target.remote_post_id) return;
  const { data: claimed, error: claimError } = await db
    .from("social_repost_jobs")
    .update({ phase: workingPhase, attempt_count: job.attempt_count + 1 })
    .eq("target_id", message.targetId)
    .eq("phase", queuedPhase)
    .select("target_id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;
  let confirmedRepostId: string | null = null;
  let providerCallStarted = false;
  try {
    if (message.action === "repost") {
      const plan = await getPlan(String(target.post.user_id));
      if (!planHasEntitlement(plan, "postScheduler")) {
        throw new ProviderError(
          "Posting access is paused for this workspace.",
          "plan_unavailable",
          false,
        );
      }
      const token = await accessTokenForConnection(target.connection);
      providerCallStarted = true;
      const repostId = await createNativeRepost(
        job.provider,
        target.connection,
        target.remote_post_id,
        token,
      );
      confirmedRepostId = repostId;
      const { error: saveError } = await db
        .from("social_repost_jobs")
        .update({
          phase: job.remove_due_at ? "reposted" : "complete",
          repost_remote_id: repostId,
          reposted_at: new Date().toISOString(),
          attempt_count: 0,
          next_attempt_at: null,
          lease_expires_at: null,
          last_error_message: null,
        })
        .eq("target_id", message.targetId)
        .eq("phase", workingPhase);
      if (saveError) throw saveError;
    } else {
      if (!job.repost_remote_id) {
        throw new ProviderError(
          "The repost ID is missing; removal needs review.",
          "missing_repost_id",
          false,
        );
      }
      await removeNativeRepost(
        job.provider,
        target.connection,
        target.remote_post_id,
        job.repost_remote_id,
      );
      const { error: saveError } = await db
        .from("social_repost_jobs")
        .update({
          phase: "removed",
          removed_at: new Date().toISOString(),
          next_attempt_at: null,
          lease_expires_at: null,
          last_error_message: null,
        })
        .eq("target_id", message.targetId)
        .eq("phase", workingPhase);
      if (saveError) throw saveError;
    }
  } catch (caught) {
    // A provider can succeed before the database acknowledges our result. If we
    // already have LinkedIn's reshare ID, record it before considering a retry.
    if (message.action === "repost" && confirmedRepostId) {
      const { error: recoveryError } = await db
        .from("social_repost_jobs")
        .update({
          phase: job.remove_due_at ? "reposted" : "complete",
          repost_remote_id: confirmedRepostId,
          reposted_at: new Date().toISOString(),
          attempt_count: 0,
          next_attempt_at: null,
          lease_expires_at: null,
          last_error_message: null,
        })
        .eq("target_id", message.targetId)
        .eq("phase", workingPhase);
      if (!recoveryError) return;
      throw recoveryError;
    }
    const timedOut = caught instanceof Error && /abort|timeout/i.test(caught.message);
    const providerError = caught instanceof ProviderError ? caught : null;
    const retryable = providerError?.retryable || timedOut || !providerError;
    const unknown =
      message.action === "repost" &&
      job.provider === "linkedin" &&
      providerCallStarted &&
      (timedOut || providerError?.code === "outcome_unknown" || !providerError);
    const attempt = job.attempt_count + 1;
    const canRetry = retryable && !unknown && attempt < 5;
    const phase = unknown
      ? "outcome_unknown"
      : canRetry
        ? message.action === "remove"
          ? "remove_retry"
          : "repost_retry"
        : "failed";
    const { error: saveError } = await db
      .from("social_repost_jobs")
      .update({
        phase,
        next_attempt_at: canRetry
          ? new Date(
              Date.now() +
                socialRetryDelaySeconds(attempt, providerError?.retryAfterSeconds) * 1_000,
            ).toISOString()
          : null,
        lease_expires_at: null,
        last_error_message:
          providerError?.message || (caught instanceof Error ? caught.message : "Repost failed."),
      })
      .eq("target_id", message.targetId)
      .eq("phase", workingPhase);
    if (saveError) throw saveError;
  }
}
