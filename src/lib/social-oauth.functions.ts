import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Provider payloads are intentionally normalized at the boundary. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { encryptServerSecret, isServerSecretEncryptionKeyValid } from "./secret-crypto.server";
import { enforceRequestRateLimit, readResponseText } from "./request-security.server";
import { socialApiErrorMessage, socialApiPayloadHasError } from "./social-provider-response";
import { requirePlanEntitlement } from "./plan.server";
import { durableSocialAvatarUrl } from "./social-avatar.server";
import {
  SOCIAL_PROVIDERS,
  isPublicSocialProvider,
  socialAccountsWithinLimit,
  type SocialProvider,
} from "./social-scheduler";

const genericProviders = SOCIAL_PROVIDERS.filter((provider) => provider !== "instagram") as Exclude<
  SocialProvider,
  "instagram"
>[];

export type GenericProvider = (typeof genericProviders)[number];
const BASIC_AUTO_DM_PROVIDERS = new Set<GenericProvider>(["facebook", "twitter"]);

async function requireCreatorSocialConnection(userId: string, provider: GenericProvider) {
  if (BASIC_AUTO_DM_PROVIDERS.has(provider)) return;
  await requirePlanEntitlement(
    userId,
    "socialConnections",
    "This social account connection is included with the Creator plan.",
  );
}

const SOCIAL_PROVIDER_SCOPES: Record<GenericProvider, readonly string[]> = {
  facebook: [
    "pages_show_list",
    "pages_read_user_content",
    "pages_read_engagement",
    "pages_manage_posts",
    "pages_manage_metadata",
    "pages_manage_engagement",
    "pages_messaging",
    "read_insights",
  ],
  threads: ["threads_basic", "threads_content_publish", "threads_manage_insights"],
  tiktok: ["user.info.basic", "user.info.stats", "video.list", "video.publish"],
  linkedin: [
    "openid",
    "profile",
    "w_member_social",
    "r_member_social",
    "r_member_profileAnalytics",
    "r_member_postAnalytics",
  ],
  twitter: [
    "tweet.read",
    "tweet.write",
    "users.read",
    "offline.access",
    "media.write",
    "like.read",
    "dm.read",
    "dm.write",
  ],
  youtube: [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ],
  reddit: ["identity", "submit", "mysubreddits", "read"],
};

export function socialProviderRequestedScopes(provider: GenericProvider) {
  return [...SOCIAL_PROVIDER_SCOPES[provider]];
}

export function normalizedSocialConnectionScopes(provider: GenericProvider, scope: unknown) {
  const returned = String(scope || "")
    .split(/[ ,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return returned.length ? [...new Set(returned)] : socialProviderRequestedScopes(provider);
}

type ProviderCredentialNames = {
  pairs: readonly (readonly [clientId: string, clientSecret: string])[];
};

const envNames: Record<GenericProvider, ProviderCredentialNames> = {
  // Facebook Pages and Instagram can be products on the same published Meta app. Prefer
  // an explicit Facebook override, while allowing Bento's existing Meta app credentials.
  facebook: {
    pairs: [
      ["META_FACEBOOK_APP_ID", "META_FACEBOOK_APP_SECRET"],
      ["META_INSTAGRAM_APP_ID", "META_INSTAGRAM_APP_SECRET"],
    ],
  },
  // Threads and Instagram are products on Bento's same published Meta app. Keep
  // explicit overrides for a future split app, but reuse the reviewed Meta app
  // by default so deployments do not require duplicate credentials.
  threads: {
    pairs: [
      ["THREADS_APP_ID", "THREADS_APP_SECRET"],
      ["META_INSTAGRAM_APP_ID", "META_INSTAGRAM_APP_SECRET"],
    ],
  },
  tiktok: { pairs: [["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]] },
  linkedin: { pairs: [["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"]] },
  twitter: { pairs: [["X_CLIENT_ID", "X_CLIENT_SECRET"]] },
  youtube: { pairs: [["GOOGLE_YOUTUBE_CLIENT_ID", "GOOGLE_YOUTUBE_CLIENT_SECRET"]] },
  reddit: { pairs: [["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"]] },
};

const REDDIT_USER_AGENT = "web:bento.surf.scheduler:1.0 (by /u/bentosurf)";

function appOrigin() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

export function socialProviderRedirectUri(provider: GenericProvider) {
  return `${appOrigin()}/integrations/social/${provider}/callback`;
}

export function assertSocialOAuthRedirectMatchesEnvironment(
  provider: GenericProvider,
  persistedRedirectUri: string,
) {
  if (persistedRedirectUri !== socialProviderRedirectUri(provider)) {
    throw new Error(
      "This connection was started on a different Bento environment. Please start again.",
    );
  }
}

function configuredCredentials(provider: GenericProvider) {
  for (const [clientIdName, clientSecretName] of envNames[provider].pairs) {
    const clientId = process.env[clientIdName]?.trim();
    const clientSecret = process.env[clientSecretName]?.trim();
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  return undefined;
}

export function socialProviderCredentialsConfigured(provider: GenericProvider) {
  return Boolean(configuredCredentials(provider));
}

function credentials(provider: GenericProvider) {
  const configured = configuredCredentials(provider);
  if (
    !configured ||
    !isServerSecretEncryptionKeyValid(process.env.SOCIAL_CONNECTION_ENCRYPTION_KEY)
  ) {
    throw new Error(`${provider} publishing is awaiting Bento's developer-app setup.`);
  }
  return configured;
}

export function socialProviderReadiness() {
  const encryptionReady = isServerSecretEncryptionKeyValid(
    process.env.SOCIAL_CONNECTION_ENCRYPTION_KEY,
  );
  return Object.fromEntries(
    SOCIAL_PROVIDERS.map((provider) => {
      if (provider === "instagram") {
        return [
          provider,
          Boolean(
            encryptionReady &&
            process.env.META_INSTAGRAM_APP_ID &&
            process.env.META_INSTAGRAM_APP_SECRET,
          ),
        ];
      }
      return [provider, Boolean(encryptionReady && socialProviderCredentialsConfigured(provider))];
    }),
  ) as Record<SocialProvider, boolean>;
}

function randomVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function codeChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function authorizationUrl(
  provider: GenericProvider,
  clientId: string,
  state: string,
  challenge: string,
) {
  const redirect = socialProviderRedirectUri(provider);
  const definitions: Record<
    GenericProvider,
    { base: string; scope: string; params?: Record<string, string> }
  > = {
    facebook: {
      base: "https://www.facebook.com/v25.0/dialog/oauth",
      scope: SOCIAL_PROVIDER_SCOPES.facebook.join(","),
    },
    threads: {
      base: "https://www.threads.net/oauth/authorize",
      scope: SOCIAL_PROVIDER_SCOPES.threads.join(","),
    },
    tiktok: {
      base: "https://www.tiktok.com/v2/auth/authorize/",
      scope: SOCIAL_PROVIDER_SCOPES.tiktok.join(","),
      params: { client_key: clientId },
    },
    linkedin: {
      base: "https://www.linkedin.com/oauth/v2/authorization",
      scope: SOCIAL_PROVIDER_SCOPES.linkedin.join(" "),
    },
    twitter: {
      base: "https://x.com/i/oauth2/authorize",
      scope: SOCIAL_PROVIDER_SCOPES.twitter.join(" "),
      params: { code_challenge: challenge, code_challenge_method: "S256" },
    },
    youtube: {
      base: "https://accounts.google.com/o/oauth2/v2/auth",
      scope: SOCIAL_PROVIDER_SCOPES.youtube.join(" "),
      params: { access_type: "offline", prompt: "consent" },
    },
    reddit: {
      base: "https://www.reddit.com/api/v1/authorize",
      scope: SOCIAL_PROVIDER_SCOPES.reddit.join(" "),
      params: { duration: "permanent" },
    },
  };
  const definition = definitions[provider];
  const url = new URL(definition.base);
  url.searchParams.set(provider === "tiktok" ? "client_key" : "client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", definition.scope);
  url.searchParams.set("state", state);
  for (const [name, value] of Object.entries(definition.params || {}))
    url.searchParams.set(name, value);
  return url.toString();
}

export const beginSocialConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ provider: z.enum(genericProviders as [GenericProvider, ...GenericProvider[]]) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireCreatorSocialConnection(context.userId, data.provider);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "social-oauth-start",
      context.userId,
    );
    if (!isPublicSocialProvider(data.provider)) {
      throw new Error(
        "This network is temporarily unavailable in Bento while we wait on platform API access.",
      );
    }
    const { clientId } = credentials(data.provider);
    const state = crypto.randomUUID();
    const verifier = randomVerifier();
    const challenge = await codeChallenge(verifier);
    const { error } = await (supabaseAdmin as any).from("social_oauth_states").insert({
      id: state,
      user_id: context.userId,
      provider: data.provider,
      code_verifier: verifier,
      redirect_uri: socialProviderRedirectUri(data.provider),
    });
    if (error) throw new Error("The connection could not be started.");
    return { url: authorizationUrl(data.provider, clientId, state, challenge) };
  });

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await readResponseText(response, 512 * 1024);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!response.ok || socialApiPayloadHasError(data)) {
    throw new Error(socialApiErrorMessage(data, "The social network rejected the connection."));
  }
  return data;
}

async function exchangeCode(
  provider: GenericProvider,
  code: string,
  verifier: string,
  redirectUri: string,
) {
  const { clientId, clientSecret } = credentials(provider);
  const fields: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    // OAuth providers require this to match the URI used when the flow began.
    // Bind the token exchange to the persisted state instead of recomputing it
    // from an environment value that may have changed between requests.
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  };
  let endpoint = "";
  if (provider === "facebook") endpoint = "https://graph.facebook.com/v25.0/oauth/access_token";
  if (provider === "threads") endpoint = "https://graph.threads.net/oauth/access_token";
  if (provider === "tiktok") {
    endpoint = "https://open.tiktokapis.com/v2/oauth/token/";
    delete fields.client_id;
    fields.client_key = clientId;
  }
  if (provider === "linkedin") endpoint = "https://www.linkedin.com/oauth/v2/accessToken";
  if (provider === "twitter") {
    endpoint = "https://api.x.com/2/oauth2/token";
    fields.code_verifier = verifier;
  }
  if (provider === "youtube") endpoint = "https://oauth2.googleapis.com/token";
  if (provider === "reddit") endpoint = "https://www.reddit.com/api/v1/access_token";
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (provider === "twitter" || provider === "reddit") {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
    delete fields.client_id;
    delete fields.client_secret;
  }
  if (provider === "reddit") headers["User-Agent"] = REDDIT_USER_AGENT;
  return fetchJson(endpoint, { method: "POST", headers, body: new URLSearchParams(fields) });
}

async function durableConnectionTokens(provider: GenericProvider, tokens: any) {
  const accessToken = String(tokens.access_token || "");
  if (!accessToken) return tokens;

  if (provider === "facebook") {
    const { clientId, clientSecret } = credentials(provider);
    const url = new URL("https://graph.facebook.com/v25.0/oauth/access_token");
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("client_secret", clientSecret);
    url.searchParams.set("fb_exchange_token", accessToken);
    const upgraded = await fetchJson(url.toString());
    return { ...tokens, ...upgraded };
  }

  if (provider === "threads") {
    const { clientSecret } = credentials(provider);
    const url = new URL("https://graph.threads.net/access_token");
    url.searchParams.set("grant_type", "th_exchange_token");
    url.searchParams.set("client_secret", clientSecret);
    url.searchParams.set("access_token", accessToken);
    const upgraded = await fetchJson(url.toString());
    return { ...tokens, ...upgraded };
  }

  return tokens;
}

export async function socialAccountProfiles(
  provider: GenericProvider,
  token: string,
  providerUserId?: string,
  timeoutMs = 30_000,
) {
  const get = (url: string, init: RequestInit = {}) => fetchJson(url, init, timeoutMs);
  const bearer = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (provider === "threads") {
    const data = await get(
      `https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url&access_token=${encodeURIComponent(token)}`,
    );
    return [
      {
        id: String(data.id),
        handle: data.username,
        name: data.username,
        avatar: data.threads_profile_picture_url,
        token,
      },
    ];
  }
  if (provider === "facebook") {
    if (providerUserId) {
      const url = new URL(`https://graph.facebook.com/v25.0/${encodeURIComponent(providerUserId)}`);
      url.searchParams.set("fields", "id,name,picture");
      url.searchParams.set("access_token", token);
      const page = await get(url.toString());
      return [
        {
          id: String(page.id),
          handle: page.name,
          name: page.name,
          avatar: page.picture?.data?.url,
          token,
        },
      ];
    }
    const data = await get(
      `https://graph.facebook.com/v25.0/me/accounts?fields=id,name,access_token,picture&access_token=${encodeURIComponent(token)}`,
    );
    return (data.data || []).map((page: any) => ({
      id: String(page.id),
      handle: page.name,
      name: page.name,
      avatar: page.picture?.data?.url,
      token: page.access_token,
    }));
  }
  if (provider === "tiktok") {
    const data = await get(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      { headers: bearer },
    );
    const user = data.data?.user || {};
    return [
      {
        id: String(user.open_id),
        handle: user.display_name,
        name: user.display_name,
        avatar: user.avatar_url,
        token,
      },
    ];
  }
  if (provider === "linkedin") {
    const data = await get("https://api.linkedin.com/v2/userinfo", { headers: bearer });
    return [
      {
        id: `urn:li:person:${data.sub}`,
        handle: data.name,
        name: data.name,
        avatar: data.picture,
        token,
      },
    ];
  }
  if (provider === "twitter") {
    const data = await get("https://api.x.com/2/users/me?user.fields=profile_image_url", {
      headers: bearer,
    });
    return [
      {
        id: String(data.data.id),
        handle: data.data.username,
        name: data.data.name,
        avatar: data.data.profile_image_url,
        token,
      },
    ];
  }
  if (provider === "reddit") {
    const data = await get("https://oauth.reddit.com/api/v1/me", {
      headers: { ...bearer, "User-Agent": REDDIT_USER_AGENT },
    });
    return [
      {
        id: String(data.id),
        handle: data.name,
        name: data.subreddit?.title || data.name,
        avatar: data.icon_img ? String(data.icon_img).split("?")[0] : null,
        token,
      },
    ];
  }
  const data = await get("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: bearer,
  });
  const channel = data.items?.[0];
  if (!channel) throw new Error("No YouTube channel was found for this Google account.");
  return [
    {
      id: String(channel.id),
      handle: channel.snippet?.customUrl || channel.snippet?.title,
      name: channel.snippet?.title,
      avatar: channel.snippet?.thumbnails?.default?.url,
      token,
    },
  ];
}

export const completeSocialConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        provider: z.enum(genericProviders as [GenericProvider, ...GenericProvider[]]),
        code: z.string().min(1).max(4_000),
        state: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireCreatorSocialConnection(context.userId, data.provider);
    await enforceRequestRateLimit(
      "EXPENSIVE_API_RATE_LIMITER",
      "social-oauth-complete",
      context.userId,
    );
    const db = supabaseAdmin as any;
    const { data: state } = await db
      .from("social_oauth_states")
      .select("*")
      .eq("id", data.state)
      .eq("provider", data.provider)
      .maybeSingle();
    await db.from("social_oauth_states").delete().eq("id", data.state);
    if (
      !state ||
      state.user_id !== context.userId ||
      new Date(state.expires_at).getTime() <= Date.now()
    ) {
      throw new Error("This connection link expired. Please start again.");
    }
    assertSocialOAuthRedirectMatchesEnvironment(data.provider, state.redirect_uri);
    const exchangedTokens = await exchangeCode(
      data.provider,
      data.code,
      state.code_verifier || "",
      state.redirect_uri,
    );
    const tokens = await durableConnectionTokens(data.provider, exchangedTokens);
    const accessToken = tokens.access_token;
    if (!accessToken) throw new Error("The social network did not return an access token.");
    const discoveredAccounts = await socialAccountProfiles(data.provider, accessToken);
    if (!discoveredAccounts.length) throw new Error("No publishable account was found.");
    const { data: existingConnections, error: existingError } = await db
      .from("social_connections")
      .select("provider_user_id")
      .eq("user_id", context.userId)
      .eq("provider", data.provider);
    if (existingError) throw new Error("The connected accounts could not be checked.");
    const accounts = socialAccountsWithinLimit(
      (existingConnections || []).map((connection: any) => String(connection.provider_user_id)),
      discoveredAccounts,
    );
    if (!accounts.length) {
      throw new Error("You can connect up to 2 profiles per social platform.");
    }
    const expiresIn = Number(tokens.expires_in || tokens.data?.expires_in || 0);
    const refreshToken = tokens.refresh_token || tokens.data?.refresh_token || null;
    const scopes = normalizedSocialConnectionScopes(data.provider, tokens.scope);
    const { error } = await db.from("social_connections").upsert(
      await Promise.all(
        accounts.map(async (account: any) => {
          const providerUserId = String(account.id);
          return {
            user_id: context.userId,
            provider: data.provider,
            provider_user_id: providerUserId,
            provider_handle: String(account.handle || account.id)
              .toLowerCase()
              .slice(0, 100),
            provider_display_name: String(account.name || account.handle || account.id).slice(
              0,
              200,
            ),
            provider_avatar_url: await durableSocialAvatarUrl({
              userId: context.userId,
              provider: data.provider,
              providerUserId,
              value: account.avatar,
            }),
            access_token: await encryptServerSecret(account.token, "social"),
            refresh_token: refreshToken ? await encryptServerSecret(refreshToken, "social") : null,
            token_expires_at:
              data.provider === "facebook"
                ? null
                : expiresIn
                  ? new Date(Date.now() + expiresIn * 1_000).toISOString()
                  : null,
            scopes,
            status: "active",
            last_error: null,
          };
        }),
      ),
      { onConflict: "user_id,provider,provider_user_id" },
    );
    if (error) {
      if (String(error.message || "").includes("up to 2 profiles")) {
        throw new Error("You can connect up to 2 profiles per social platform.");
      }
      throw new Error("The connected account could not be saved.");
    }
    return { connected: accounts.length, skipped: discoveredAccounts.length - accounts.length };
  });

export const disconnectSocialConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await (supabaseAdmin as any)
      .from("social_connections")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error("The account could not be disconnected.");
    return { ok: true };
  });
