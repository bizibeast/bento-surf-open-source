/* eslint-disable @typescript-eslint/no-explicit-any -- The grant table is service-role only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readResponseText } from "./request-security.server";
import { parsePublicHttpUrl } from "./safe-url";
import { decryptServerSecret, encryptServerSecret } from "./secret-crypto.server";
import { instagramAudioCatalogInputSchema } from "./instagram-audio";
import { requirePlanEntitlement } from "./plan.server";
import { enforceRequestRateLimit } from "./request-security.server";

const db = supabaseAdmin as any;

export const INSTAGRAM_AUDIO_GRAPH_URL = "https://graph.facebook.com/v25.0";
export const INSTAGRAM_AUDIO_PERMISSIONS = [
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
];

export type InstagramAudioTrack = {
  id: string;
  title: string;
  creator: string | null;
  artworkUrl: string | null;
  previewUrl: string | null;
  instagramUrl: string | null;
  durationMs: number | null;
};

type FacebookInstagramPage = { instagram_business_account?: { id?: unknown; username?: unknown } };

async function facebookInstagramAudioJson(
  path: string,
  token: string,
  search: Record<string, string>,
) {
  const url = new URL(`${INSTAGRAM_AUDIO_GRAPH_URL}/${path}`);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  const payload = JSON.parse(await readResponseText(response, 512 * 1024));
  if (!response.ok || payload.error)
    throw new Error(
      "Meta could not authorize Instagram audio. Check the linked Facebook Page and permissions.",
    );
  return payload;
}

export async function requireInstagramAudioDestination(userId: string, connectionId: string) {
  const { data, error } = await supabaseAdmin
    .from("social_connections")
    .select("provider_user_id,provider_handle")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider", "instagram")
    .eq("status", "active")
    .maybeSingle();
  if (error || !data)
    throw new Error("Connect the Instagram account in Bento before enabling audio.");
  return data;
}

export async function saveInstagramAudioAuthorization(input: {
  userId: string;
  connectionId: string;
  token: string;
  expiresIn: number;
}) {
  const destination = await requireInstagramAudioDestination(input.userId, input.connectionId);
  const [pages, permissions] = await Promise.all([
    facebookInstagramAudioJson("me/accounts", input.token, {
      fields: "instagram_business_account{id,username}",
      limit: "100",
    }),
    facebookInstagramAudioJson("me/permissions", input.token, {}),
  ]);
  const grants = new Set(
    (Array.isArray(permissions.data) ? permissions.data : []).flatMap(
      (permission: { status?: string; permission?: string }) =>
        permission.status === "granted" ? [permission.permission] : [],
    ),
  );
  if (!INSTAGRAM_AUDIO_PERMISSIONS.every((permission) => grants.has(permission)))
    throw new Error("Approve Instagram publishing and access to the linked Facebook Page.");
  const handle = destination.provider_handle.trim().replace(/^@/, "").toLowerCase();
  const account = (Array.isArray(pages.data) ? (pages.data as FacebookInstagramPage[]) : [])
    .map((page) => page.instagram_business_account)
    .find(
      (ig) =>
        typeof ig?.id === "string" &&
        /^\d{1,30}$/.test(ig.id) &&
        (ig.id === destination.provider_user_id ||
          (handle && typeof ig.username === "string" && ig.username.toLowerCase() === handle)),
    );
  if (typeof account?.id !== "string")
    throw new Error("Choose the Facebook Page linked to this Instagram professional account.");
  const { error } = await db.from("instagram_audio_connections").upsert({
    connection_id: input.connectionId,
    user_id: input.userId,
    instagram_user_id: account.id,
    access_token: await encryptServerSecret(input.token, "social"),
    expires_at:
      input.expiresIn > 0 ? new Date(Date.now() + input.expiresIn * 1000).toISOString() : null,
  });
  if (error) throw new Error("Instagram audio authorization could not be saved.");
}

export async function instagramAudioAuthorization(userId: string, connectionId: string) {
  const { data, error } = await db
    .from("instagram_audio_connections")
    .select("instagram_user_id,access_token,expires_at")
    .eq("connection_id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Instagram audio authorization could not be checked.");
  if (!data || (data.expires_at && Date.parse(data.expires_at) <= Date.now())) return null;
  return {
    userId: data.instagram_user_id,
    token: await decryptServerSecret(data.access_token, "social"),
  };
}

/** Shared by the existing Scheduler picker and authenticated agent/MCP reads. */
export async function getInstagramAudioCatalogForUser(userId: string, input: unknown) {
  const data = instagramAudioCatalogInputSchema.parse(input);
  await requirePlanEntitlement(userId, "postScheduler", "Upgrade to schedule Instagram Reels.");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "instagram-audio", userId);
  await requireInstagramAudioDestination(userId, data.connectionId);
  const authorization = await instagramAudioAuthorization(userId, data.connectionId);
  const metadata = {
    connectionId: data.connectionId,
    type: data.type,
    query: data.query,
    mode: data.query ? ("search" as const) : ("trending" as const),
    observedAt: new Date().toISOString(),
    limitations: [
      "Meta's account-eligible catalog can differ from the Instagram app.",
      "Reels only. Meta provides track previews, not a finished Reel preview with the selected audio.",
      "Preview URLs expire; do not save them as publishing media. Track start offsets are unsupported.",
    ],
  };
  if (!authorization)
    return {
      ...metadata,
      connected: false as const,
      tracks: [] as InstagramAudioTrack[],
      nextStep:
        "Connect with Facebook from the Instagram Reel audio picker in Bento's Scheduler, using the Page linked to this Instagram account.",
    };
  return {
    ...metadata,
    connected: true as const,
    tracks: await searchInstagramAudio(authorization, data.type, data.query),
    nextStep: null,
  };
}

export async function getInstagramAudioCatalogForMcp(userId: string, input: unknown) {
  await requirePlanEntitlement(
    userId,
    "mcpSocialAutomation",
    "MCP social automation is not available for this plan.",
  );
  return getInstagramAudioCatalogForUser(userId, input);
}

export async function searchInstagramAudio(
  authorization: { userId: string; token: string },
  type: "music" | "original_sound",
  query: string,
): Promise<InstagramAudioTrack[]> {
  const payload = await facebookInstagramAudioJson("ig_audio", authorization.token, {
    audio_type: type,
    user_id: authorization.userId,
    ...(query && { search_query: query }),
  });
  const audio = Array.isArray(payload.audio) ? payload.audio : [];
  const url = (value: unknown) =>
    typeof value === "string"
      ? parsePublicHttpUrl(value, { requireHttps: true })?.toString() || null
      : null;
  return audio.slice(0, 30).flatMap((track: Record<string, unknown>) => {
    if (typeof track.audio_id !== "string" || !/^\d{1,30}$/.test(track.audio_id)) return [];
    const creator = track.display_artist || track.ig_username;
    return [
      {
        id: track.audio_id,
        title:
          typeof track.title === "string" && track.title.trim()
            ? track.title.trim().slice(0, 255)
            : "Original audio",
        creator: typeof creator === "string" ? creator.slice(0, 255) : null,
        artworkUrl: url(track.cover_artwork_thumbnail_uri || track.profile_picture_url),
        previewUrl: url(track.download_url),
        instagramUrl: url(track.on_platform_audio_preview_link),
        durationMs:
          typeof track.duration_in_ms === "number" && Number.isFinite(track.duration_in_ms)
            ? track.duration_in_ms
            : null,
      },
    ];
  });
}
