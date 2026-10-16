/* eslint-disable @typescript-eslint/no-explicit-any -- Provider responses are validated before use. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requirePlanEntitlement } from "./plan.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { accessTokenForConnection } from "./social-publisher.server";
import { decryptServerSecret } from "./secret-crypto.server";
import type { SocialMentionSuggestion } from "./social-mentions";
import { PUBLIC_SOCIAL_PROVIDERS } from "./social-scheduler";
import { searchBrightDataMentionProfiles } from "./social-mention-bright-data.server";

const searchInput = z.object({
  connectionId: z.string().uuid(),
  query: z.string().trim().max(60),
});

function result(
  provider: SocialMentionSuggestion["provider"],
  items: SocialMentionSuggestion[],
  detail?: string,
) {
  return { provider, items: items.slice(0, 3), detail: detail || null };
}

type LookupFailure = { status: number; code?: number };

function lookupFailureDetail(platform: string, failure: LookupFailure | null, fallback: string) {
  if (!failure) return fallback;
  const suffix = failure.code ? ` (provider code ${failure.code})` : "";
  if (failure.status === 401)
    return `${platform} rejected this account's authorization (HTTP 401${suffix}). Reconnect it.`;
  if (failure.status === 402)
    return `${platform} requires API credits or paid access for account lookup (HTTP 402${suffix}). Check the API project connected to Bento.`;
  if (failure.status === 403)
    return `${platform} denied account lookup (HTTP 403${suffix}). Check this app's API access and approved permissions.`;
  if (failure.status === 429)
    return `${platform} account lookup is rate limited (HTTP 429${suffix}). Try again later.`;
  if (failure.status === 404)
    return `${platform} account lookup endpoint was not found (HTTP 404${suffix}).`;
  if (failure.status >= 500)
    return `${platform} account lookup is temporarily unavailable (HTTP ${failure.status}${suffix}).`;
  return `${platform} rejected account lookup (HTTP ${failure.status}${suffix}). Check the app connection.`;
}

async function providerGet(
  url: URL,
  token: string,
  bearer = false,
  onFailure?: (failure: LookupFailure) => void,
) {
  if (!bearer) url.searchParams.set("access_token", token);
  const response = await fetch(url, {
    headers: bearer ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    // Only expose numeric status/error codes. Provider bodies may include private
    // account data and should never be reflected in the composer.
    let code: number | undefined;
    try {
      const body = (await response.json()) as { error?: { code?: unknown } };
      const providerCode = body?.error?.code;
      if (Number.isInteger(providerCode)) code = Number(providerCode);
    } catch {
      // An HTML or empty provider error still has a useful HTTP status.
    }
    onFailure?.({ status: response.status, code });
    return null;
  }
  const data = await response.json();
  return data && typeof data === "object" ? (data as any) : null;
}

async function facebookAppSecretProof(token: string) {
  const secret = facebookAppCredentials()?.secret;
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function facebookAppCredentials() {
  const pairs = [
    [process.env.META_FACEBOOK_APP_ID, process.env.META_FACEBOOK_APP_SECRET],
    [process.env.META_INSTAGRAM_APP_ID, process.env.META_INSTAGRAM_APP_SECRET],
  ];
  for (const [id, secret] of pairs) {
    if (id?.trim() && secret?.trim()) return { id: id.trim(), secret: secret.trim() };
  }
  return null;
}

export async function searchSocialMentionsForUser(
  userId: string,
  input: z.infer<typeof searchInput>,
) {
  const { connectionId, query } = searchInput.parse(input);
  await requirePlanEntitlement(userId, "postScheduler", "Post Scheduler is not available.");
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "mention-lookup", userId);
  const { data: connection, error } = await (supabaseAdmin as any)
    .from("social_connections")
    .select(
      "id,provider,status,reauth_required,scopes,access_token,refresh_token,token_expires_at,facebook_user_access_token",
    )
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !connection || connection.status !== "active" || connection.reauth_required)
    throw new Error("Reconnect this social account to look up mentions.");
  const provider = connection.provider as SocialMentionSuggestion["provider"];
  if (!PUBLIC_SOCIAL_PROVIDERS.includes(provider))
    throw new Error("This platform is not available in Post Scheduler.");
  const handle = query.replace(/^@/, "").trim();
  if (handle.length < 3) return result(provider, [], "Type at least 3 letters to search accounts.");
  const validHandle = /^[A-Za-z0-9_.-]{3,60}$/.test(handle);
  const { data: previousTargets } = await (supabaseAdmin as any)
    .from("social_post_targets")
    .select("provider_settings,post:social_posts(body)")
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: false })
    .limit(50);
  const remembered: SocialMentionSuggestion[] = [];
  for (const target of previousTargets || []) {
    const mentions = target.provider_settings?.mentions;
    if (!Array.isArray(mentions)) continue;
    for (const mention of mentions) {
      if (
        mention?.provider !== provider ||
        typeof mention.id !== "string" ||
        typeof mention.name !== "string" ||
        !`${mention.name} ${mention.handle || ""}`.toLowerCase().includes(query.toLowerCase())
      )
        continue;
      remembered.push({
        provider,
        id: mention.id,
        name: mention.name,
        handle: typeof mention.handle === "string" ? mention.handle : null,
        kind: ["person", "page", "channel", "handle"].includes(mention.kind)
          ? mention.kind
          : "handle",
        verified: mention.verified === true,
        detail: mention.verified
          ? "Used in an earlier post"
          : "Earlier text mention; account not verified",
      });
    }
  }
  // Connected providers rarely expose a general people directory. The creator's
  // own indexed posts provide useful, account-specific suggestions immediately,
  // including before any mention has been inserted through this composer.
  const { data: indexedPosts } = await (supabaseAdmin as any)
    .from("social_content_insights")
    .select("caption")
    .eq("user_id", userId)
    .eq("connection_id", connectionId)
    .order("published_at", { ascending: false })
    .limit(300);
  const historical: SocialMentionSuggestion[] = [];
  const seenHistorical = new Set<string>();
  const priorCaptions = [
    ...(indexedPosts || []).map((post: any) => post.caption),
    ...(previousTargets || []).map((target: any) => target.post?.body),
  ];
  for (const caption of priorCaptions) {
    if (typeof caption !== "string") continue;
    for (const match of caption.matchAll(/(^|[\s([{])@([A-Za-z0-9_][A-Za-z0-9_.-]{0,59})/g)) {
      const candidate = match[2].replace(/[.-]+$/, "");
      if (
        !candidate ||
        !candidate.toLowerCase().startsWith(handle.toLowerCase()) ||
        (provider === "twitter" && !/^[A-Za-z0-9_]{1,15}$/.test(candidate))
      )
        continue;
      const key = candidate.toLowerCase();
      if (seenHistorical.has(key)) continue;
      seenHistorical.add(key);
      historical.push({
        provider,
        id: candidate,
        name: candidate,
        handle: candidate,
        kind: "handle",
        verified: false,
        detail: "Seen in your past posts. Check the account before publishing.",
      });
      if (historical.length >= 8) break;
    }
    if (historical.length >= 8) break;
  }
  const finish = async (items: SocialMentionSuggestion[], detail?: string) => {
    // Free native lookups already identify real accounts. Pay for public discovery
    // only when that platform cannot return an account for the current query.
    const publicProfiles = items.length
      ? { items: [] as SocialMentionSuggestion[], detail: null }
      : await searchBrightDataMentionProfiles(provider, handle);
    const seen = new Set<string>();
    return result(
      provider,
      [...items, ...remembered, ...publicProfiles.items, ...historical].filter((item) => {
        const key = item.handle
          ? `${item.provider}:handle:${item.handle.toLowerCase()}`
          : `${item.provider}:id:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      publicProfiles.items.length
        ? publicProfiles.detail || undefined
        : [detail, publicProfiles.detail].filter(Boolean).join(" ") || undefined,
    );
  };
  // X reads are metered per account. Bright Data supplies public X profile
  // discovery; the official X API remains the only route for publishing.
  if (provider === "twitter" || provider === "tiktok") return finish([]);
  let token = "";
  try {
    token = await accessTokenForConnection(connection);
  } catch {
    return finish([], "Reconnect this account to search. You can still type a handle manually.");
  }
  try {
    if (provider === "facebook") {
      let lookupFailure: LookupFailure | null = null;
      const fetchPages = async (accessToken: string) => {
        const url = new URL("https://graph.facebook.com/v25.0/pages/search");
        url.searchParams.set("q", query);
        url.searchParams.set("fields", "id,name,link");
        url.searchParams.set("limit", "8");
        const proof = await facebookAppSecretProof(accessToken);
        if (proof) url.searchParams.set("appsecret_proof", proof);
        return providerGet(url, accessToken, false, (failure) => {
          if (!lookupFailure?.code || failure.code) lookupFailure = failure;
        });
      };
      let userToken: string | null = null;
      if (connection.facebook_user_access_token) {
        try {
          userToken = await decryptServerSecret(connection.facebook_user_access_token, "social");
        } catch {
          // An older or corrupt token can still use the app/Page fallback below.
        }
      }
      let data = userToken ? await fetchPages(userToken) : null;
      const appCredentials = facebookAppCredentials();
      if (!data && appCredentials)
        data = await fetchPages(`${appCredentials.id}|${appCredentials.secret}`);
      if (!data) data = await fetchPages(token);
      return finish(
        (Array.isArray(data?.data) ? data.data : []).flatMap((page: any) =>
          /^\d+$/.test(String(page?.id || "")) && page?.name
            ? [
                {
                  provider,
                  id: String(page.id),
                  name: String(page.name),
                  handle: null,
                  kind: "page" as const,
                  verified: true,
                  detail: String(page.link || "Facebook Page"),
                },
              ]
            : [],
        ),
        data
          ? undefined
          : lookupFailureDetail(
              "Facebook",
              lookupFailure,
              "Facebook returned no matching Pages. You can still type a Page name.",
            ),
      );
    }
    if (provider === "youtube") {
      let lookupFailure: LookupFailure | null = null;
      // Exact handle lookup costs one quota unit. Broad channel search costs 100
      // units per keystroke, so it must not run from this live picker.
      if (validHandle) {
        const exact = new URL("https://www.googleapis.com/youtube/v3/channels");
        exact.searchParams.set("part", "snippet");
        exact.searchParams.set("forHandle", handle);
        const found = await providerGet(exact, token, true, (failure) => {
          lookupFailure = failure;
        });
        const channel = found?.items?.[0];
        if (channel?.id && channel.snippet)
          return finish([
            {
              provider,
              id: String(channel.id),
              name: String(channel.snippet.title || handle),
              handle,
              kind: "channel",
              verified: true,
              avatarUrl: channel.snippet.thumbnails?.default?.url || null,
              detail:
                "Channel found. YouTube may still treat this as caption text after API upload.",
            },
          ]);
      }
      return finish(
        [],
        lookupFailureDetail(
          "YouTube",
          lookupFailure,
          "Try the channel's exact @handle. YouTube does not verify tags created through API uploads.",
        ),
      );
    }
    if (provider === "threads") {
      if (!connection.scopes?.includes("threads_profile_discovery"))
        return finish(
          [],
          "Threads account lookup needs profile discovery permission. You can insert a handle manually.",
        );
      if (!validHandle) return finish([]);
      const url = new URL("https://graph.threads.com/v1.0/profile_lookup");
      url.searchParams.set("username", handle);
      url.searchParams.set("fields", "username,name,profile_picture_url");
      let lookupFailure: LookupFailure | null = null;
      const data = await providerGet(url, token, false, (failure) => {
        lookupFailure = failure;
      });
      return finish(
        data?.username
          ? [
              {
                provider,
                id: String(data.id || data.username),
                name: String(data.name || data.username),
                handle: String(data.username),
                kind: "person",
                verified: true,
                avatarUrl: data.profile_picture_url || null,
              },
            ]
          : [],
        data
          ? undefined
          : lookupFailureDetail(
              "Threads",
              lookupFailure,
              "Threads returned no matching profile. You can insert a handle as text.",
            ),
      );
    }
    if (provider === "instagram") {
      const businessId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID?.trim();
      const businessToken = process.env.INSTAGRAM_ACCESS_TOKEN?.trim();
      if (!validHandle || !businessId || !businessToken)
        return finish(
          [],
          "Instagram offers exact professional account lookup here. You can insert any handle manually.",
        );
      const url = new URL(`https://graph.facebook.com/v25.0/${businessId}`);
      url.searchParams.set(
        "fields",
        `business_discovery.username(${handle}){id,username,name,profile_picture_url}`,
      );
      let lookupFailure: LookupFailure | null = null;
      const data = await providerGet(url, businessToken, false, (failure) => {
        lookupFailure = failure;
      });
      const account = data?.business_discovery;
      return finish(
        account?.username
          ? [
              {
                provider,
                id: String(account.id || account.username),
                name: String(account.name || account.username),
                handle: String(account.username),
                kind: "person",
                verified: true,
                avatarUrl: account.profile_picture_url || null,
              },
            ]
          : [],
        lookupFailureDetail(
          "Instagram",
          lookupFailure,
          "Instagram only returns eligible professional accounts through this lookup.",
        ),
      );
    }
    if (provider === "linkedin") {
      // This is an exact company vanity-name lookup. People typeahead requires restricted API access.
      if (!/^[A-Za-z0-9_-]{2,60}$/.test(handle)) return finish([]);
      const url = new URL("https://api.linkedin.com/rest/organizations");
      url.searchParams.set("q", "vanityName");
      url.searchParams.set("vanityName", handle);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Linkedin-Version": process.env.LINKEDIN_API_VERSION?.trim() || "202606",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        signal: AbortSignal.timeout(8_000),
      });
      const data = response.ok ? ((await response.json()) as any) : null;
      const lookupFailure = response.ok ? null : { status: response.status };
      return finish(
        (Array.isArray(data?.elements) ? data.elements : []).flatMap((company: any) =>
          company?.id && company?.localizedName
            ? [
                {
                  provider,
                  id: `urn:li:organization:${company.id}`,
                  name: String(company.localizedName),
                  handle: String(company.vanityName || handle),
                  kind: "page" as const,
                  verified: true,
                },
              ]
            : [],
        ),
        data
          ? "LinkedIn people search needs separate API approval."
          : lookupFailureDetail(
              "LinkedIn",
              lookupFailure,
              "LinkedIn returned no matching company. People search needs separate approval.",
            ),
      );
    }
  } catch {
    return finish(
      [],
      "Account lookup is temporarily unavailable. You can insert a handle manually.",
    );
  }
  return finish(
    [],
    "This platform does not offer account search to this connection. You can insert a handle manually.",
  );
}

export const searchSocialMentions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => searchInput.parse(input))
  .handler(({ context, data }) => searchSocialMentionsForUser(context.userId, data));
