/* eslint-disable @typescript-eslint/no-explicit-any -- Additive production tables precede generated types. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadReelProductionForActor } from "./content-reel-production.server";
import type { ExternalToolActor } from "./external-tools.server";
import { encryptServerSecret, decryptServerSecret } from "./secret-crypto.server";
import { getMediaBucket, mediaObjectUrl, sumR2UserStorageBytes } from "./r2-storage.server";
import { getStorageAllowanceMb } from "./plan.server";
import { adjustCachedR2UserStorageBytes } from "./r2-usage-cache.server";
import { saveStudioSchedulerDraft } from "./content-studio-scheduler.server";
import { STUDIO_REEL_OUTPUT_LIMIT } from "./studio-reel-host";
import { enforceRequestRateLimit } from "./request-security.server";

const grantSchema = z
  .object({
    workspaceId: z.uuid(),
    authUserId: z.uuid(),
    productionId: z.uuid(),
    expiresAt: z.number(),
  })
  .strict();
const key = (workspaceId: string, renderId: string) =>
  `private/users/${workspaceId}/studio/${renderId}.mp4`;
export async function getReelProductionPreview(actor: ExternalToolActor, id: string) {
  const production = await loadReelProductionForActor(actor, id);
  if (production.status !== "ready" || !production.state.renderJobId)
    throw new Error("The preview is not ready.");
  const grant = await encryptServerSecret(
    JSON.stringify({
      workspaceId: actor.workspaceId,
      authUserId: actor.authUserId,
      productionId: id,
      expiresAt: Date.now() + 15 * 60_000,
    }),
    "external-tool",
  );
  return { previewUrl: `/api/studio/reel-preview?grant=${encodeURIComponent(grant)}` };
}

export async function handleReelProductionPreview(request: Request) {
  const missing = () =>
    new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
  const token = new URL(request.url).searchParams.get("grant");
  if (!token || token.length > 1200) return missing();
  try {
    const grant = grantSchema.parse(JSON.parse(await decryptServerSecret(token, "external-tool")));
    if (grant.expiresAt <= Date.now()) return missing();
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "studio-reel-preview",
      grant.workspaceId,
    );
    const production = await loadReelProductionForActor(
      { workspaceId: grant.workspaceId, authUserId: grant.authUserId, clientId: "bento-browser" },
      grant.productionId,
    );
    if (production.status !== "ready" || !production.state.renderJobId) return missing();
    const objectKey = key(grant.workspaceId, production.state.renderJobId);
    const bucket = getMediaBucket();
    const object = await bucket.head(objectKey);
    if (!object || object.size > STUDIO_REEL_OUTPUT_LIMIT) return missing();
    const headers = new Headers({
      "content-type": "video/mp4",
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      "accept-ranges": "bytes",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") return new Response(null, { headers });
    let range: { offset: number; length: number } | undefined;
    const requested = request.headers.get("range");
    if (requested) {
      const match = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(requested);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
      const offset = match[1] ? Number(match[1]) : Math.max(0, object.size - Number(match[2]));
      const end =
        match[1] && match[2] ? Math.min(object.size - 1, Number(match[2])) : object.size - 1;
      if (offset > end || offset >= object.size) return new Response(null, { status: 416 });
      range = { offset, length: end - offset + 1 };
      headers.set("content-range", `bytes ${offset}-${end}/${object.size}`);
      headers.set("content-length", String(range.length));
    }
    const body = await bucket.get(objectKey, range ? { range } : undefined);
    return body ? new Response(body.body, { status: range ? 206 : 200, headers }) : missing();
  } catch {
    return missing();
  }
}

/** Explicit browser approval makes a public publishing copy; this creates a draft, never publishes. */
export async function approveReelForScheduler(actor: ExternalToolActor, id: string) {
  if (actor.clientId !== "bento-browser") throw new Error("Approve the video preview in Bento.");
  const row = await loadReelProductionForActor(actor, id);
  if (row.status !== "ready" || !row.state.renderJobId)
    throw new Error("Review the finished video first.");
  const db = supabaseAdmin as any;
  if (row.publication) {
    const connections = await db
      .from("social_connections")
      .select("id")
      .eq("user_id", actor.workspaceId)
      .eq("status", "active")
      .in("id", row.publication.connectionIds)
      .limit(row.publication.connectionIds.length);
    if (connections.error || connections.data?.length !== row.publication.connectionIds.length)
      throw new Error("Reconnect the selected publishing accounts before approval.");
  }
  let mediaIds = row.media_ids;
  if (!mediaIds.length) {
    if (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now())
      throw new Error("The publishing copy is being prepared. Try again shortly.");
    const lease = crypto.randomUUID();
    let claim = db
      .from("studio_reel_productions")
      .update({
        lease_id: lease,
        lease_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      .eq("id", id)
      .eq("workspace_id", actor.workspaceId)
      .eq("auth_user_id", actor.authUserId)
      .eq("status", "ready");
    claim = row.lease_id ? claim.eq("lease_id", row.lease_id) : claim.is("lease_id", null);
    const claimed = await claim.select("id").maybeSingle();
    if (claimed.error || !claimed.data)
      throw new Error("The publishing copy is already being prepared.");
    try {
      const bucket = getMediaBucket();
      const object = await bucket.get(key(row.workspace_id, row.state.renderJobId));
      if (!object || object.size > STUDIO_REEL_OUTPUT_LIMIT)
        throw new Error("The export is unavailable.");
      const publicKey = `users/${row.workspace_id}/video/studio-${row.state.renderJobId}.mp4`;
      const prior = await bucket.head(publicKey);
      if (!prior) {
        const [used, allowance] = await Promise.all([
          sumR2UserStorageBytes(bucket, row.workspace_id),
          getStorageAllowanceMb(row.workspace_id),
        ]);
        if (used + object.size > allowance * 1024 * 1024) {
          await object.body.cancel();
          throw new Error("Free some storage before preparing the publishing copy.");
        }
        await bucket.put(publicKey, object.body, {
          httpMetadata: {
            contentType: "video/mp4",
            cacheControl: "public, max-age=31536000, immutable",
          },
        });
        await adjustCachedR2UserStorageBytes(row.workspace_id, object.size).catch(() => undefined);
      } else await object.body.cancel();
      const registered = await db.rpc("register_creator_uploaded_media", {
        p_user_id: row.workspace_id,
        p_key: publicKey,
        p_url: mediaObjectUrl(publicKey),
        p_name: `${row.title}.mp4`,
        p_mime: "video/mp4",
        p_bytes: object.size,
      });
      if (registered.error) throw new Error("The approved video could not be saved to Files.");
      mediaIds = [z.uuid().parse(registered.data)];
      const saved = await db
        .from("studio_reel_productions")
        .update({ media_ids: mediaIds })
        .eq("id", id)
        .eq("workspace_id", actor.workspaceId)
        .eq("auth_user_id", actor.authUserId)
        .eq("status", "ready")
        .eq("lease_id", lease)
        .select("id")
        .maybeSingle();
      if (saved.error || !saved.data)
        throw new Error("The publishing approval could not be saved.");
    } finally {
      await db
        .from("studio_reel_productions")
        .update({ lease_id: null, lease_expires_at: null })
        .eq("id", id)
        .eq("workspace_id", actor.workspaceId)
        .eq("auth_user_id", actor.authUserId)
        .eq("lease_id", lease);
    }
  }
  return saveStudioSchedulerDraft({
    workspaceId: row.workspace_id,
    requestId: row.id,
    title: row.title,
    mediaIds,
    proposal: row.publication,
  });
}
