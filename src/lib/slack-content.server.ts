/* eslint-disable @typescript-eslint/no-explicit-any -- Content connection rows ship with migrations. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  decryptServerSecret,
  encryptServerSecret,
  isServerSecretEncryptionKeyValid,
} from "./secret-crypto.server";
import {
  ContentProviderAuthError,
  consumeContentOAuthState,
  type ContentConnection,
  type ContentProviderAdapter,
} from "./content-connections.server";

const SLACK_API = "https://slack.com/api";
const SLACK_SCOPES = ["channels:read", "channels:history"] as const;

function slackCredentials() {
  const clientId = process.env.SLACK_CONTENT_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.SLACK_CONTENT_CLIENT_SECRET?.trim() || "";
  const redirectUri =
    process.env.SLACK_CONTENT_REDIRECT_URI?.trim() ||
    `${(process.env.VITE_APP_URL?.trim() || "http://localhost:8080").replace(/\/$/, "")}/integrations/slack/callback`;
  if (!clientId || !clientSecret) throw new Error("Slack Content is not configured.");
  return { clientId, clientSecret, redirectUri };
}

export function slackReady() {
  try {
    slackCredentials();
    return isServerSecretEncryptionKeyValid(process.env.CONTENT_CONNECTION_ENCRYPTION_KEY);
  } catch {
    return false;
  }
}

export function slackAuthorizationUrl(state: string) {
  const { clientId, redirectUri } = slackCredentials();
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_SCOPES.join(","),
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
}

type SlackToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scopes: string[];
  teamId: string;
  teamName: string;
};

const slackTokenResponseSchema = z
  .object({
    ok: z.literal(true),
    access_token: z.string().min(1).max(10_000),
    refresh_token: z.string().min(1).max(10_000).optional(),
    expires_in: z.number().int().positive().optional(),
    scope: z.string().max(2_000).default(""),
    team: z.object({ id: z.string().min(1).max(500), name: z.string().min(1).max(160) }),
  })
  .passthrough();

function slackToken(value: unknown): SlackToken {
  const token = slackTokenResponseSchema.parse(value);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    expiresIn: token.expires_in || null,
    scopes: token.scope
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    teamId: token.team.id,
    teamName: token.team.name,
  };
}

export async function exchangeSlackCode(code: string, fetcher: typeof fetch = fetch) {
  const { clientId, clientSecret, redirectUri } = slackCredentials();
  const response = await fetcher(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Slack authorization failed.");
  const value = await response.json();
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).ok !== true) {
    throw new Error("Slack authorization failed.");
  }
  return slackToken(value);
}

async function saveSlackConnection(userId: string, token: SlackToken) {
  const db = supabaseAdmin as any;
  const { data: existing } = await db
    .from("content_connections")
    .select("selected_resources,sync_cursor")
    .eq("user_id", userId)
    .eq("provider", "slack")
    .eq("external_account_id", token.teamId)
    .maybeSingle();
  const { error } = await db.from("content_connections").upsert(
    {
      user_id: userId,
      provider: "slack",
      external_account_id: token.teamId,
      display_name: token.teamName,
      status: "active",
      scopes: token.scopes,
      selected_resources: existing?.selected_resources || { ids: [] },
      access_token_ciphertext: await encryptServerSecret(token.accessToken, "content"),
      refresh_token_ciphertext: token.refreshToken
        ? await encryptServerSecret(token.refreshToken, "content")
        : null,
      token_expires_at: token.expiresIn
        ? new Date(Date.now() + token.expiresIn * 1_000).toISOString()
        : null,
      metadata: {},
      sync_cursor: existing?.sync_cursor || null,
      last_error: null,
    },
    { onConflict: "user_id,provider,external_account_id" },
  );
  if (error) throw new Error("Slack connection could not be saved.");
}

export async function completeSlackConnectionForUser(
  userId: string,
  input: { code: string; state: string },
  dependencies: {
    consumeState: typeof consumeContentOAuthState;
    exchange: typeof exchangeSlackCode;
    save: (userId: string, token: SlackToken) => Promise<unknown>;
  } = {
    consumeState: consumeContentOAuthState,
    exchange: exchangeSlackCode,
    save: saveSlackConnection,
  },
) {
  const state = await dependencies.consumeState({ userId, provider: "slack", state: input.state });
  if (!state) throw new Error("This Slack connection expired. Start again.");
  const token = await dependencies.exchange(input.code);
  await dependencies.save(userId, token);
  return { teamId: token.teamId, displayName: token.teamName };
}

export function slackRetryAfterMs(response: Response) {
  const seconds = Number(response.headers.get("retry-after") || 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 900) * 1_000 : 30_000;
}

export class SlackRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Slack is rate limited. Try again later.");
  }
}

async function refreshSlackAccessToken(
  connection: ContentConnection,
  fetcher: typeof fetch = fetch,
) {
  if (!connection.refreshTokenCiphertext) throw new ContentProviderAuthError("Reconnect Slack.");
  const { clientId, clientSecret } = slackCredentials();
  const response = await fetcher(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: await decryptServerSecret(connection.refreshTokenCiphertext, "content"),
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Slack token refresh failed.");
  const value = await response.json();
  const token = z
    .object({
      ok: z.literal(true),
      access_token: z.string().min(1).max(10_000),
      refresh_token: z.string().min(1).max(10_000).optional(),
      expires_in: z.number().int().positive().optional(),
    })
    .parse(value);
  const { error } = await (supabaseAdmin as any)
    .from("content_connections")
    .update({
      access_token_ciphertext: await encryptServerSecret(token.access_token, "content"),
      ...(token.refresh_token
        ? { refresh_token_ciphertext: await encryptServerSecret(token.refresh_token, "content") }
        : {}),
      token_expires_at: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1_000).toISOString()
        : null,
      status: "active",
      last_error: null,
    })
    .eq("id", connection.id)
    .eq("user_id", connection.userId)
    .eq("provider", "slack");
  if (error) throw new Error("Slack refreshed credentials could not be saved.");
  return token.access_token;
}

async function slackRequest(
  token: string,
  method: string,
  params: Record<string, string>,
  fetcher: typeof fetch,
) {
  const url = new URL(`${SLACK_API}/${method}`);
  url.search = new URLSearchParams(params).toString();
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) throw new SlackRateLimitError(slackRetryAfterMs(response));
  if (!response.ok) throw new Error(`Slack request failed (${response.status}).`);
  const value = (await response.json()) as Record<string, unknown>;
  if (value.ok !== true) {
    const code = typeof value.error === "string" ? value.error : "unknown";
    if (["invalid_auth", "token_expired", "account_inactive"].includes(code)) {
      throw new ContentProviderAuthError("Slack authorization expired. Reconnect Slack.");
    }
    throw new Error(`Slack request failed (${code}).`);
  }
  return value;
}

type SlackChannel = { id: string; name: string };

async function joinedPublicChannels(token: string, fetcher: typeof fetch) {
  const channels: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 2; page += 1) {
    const value = await slackRequest(
      token,
      "conversations.list",
      {
        types: "public_channel",
        exclude_archived: "true",
        limit: "200",
        ...(cursor ? { cursor } : {}),
      },
      fetcher,
    );
    const rows = Array.isArray(value.channels) ? value.channels : [];
    for (const item of rows) {
      if (!item || typeof item !== "object") continue;
      const channel = item as Record<string, unknown>;
      if (
        channel.is_member !== true ||
        channel.is_private === true ||
        typeof channel.id !== "string" ||
        typeof channel.name !== "string"
      )
        continue;
      channels.push({ id: channel.id, name: channel.name });
    }
    const metadata =
      value.response_metadata && typeof value.response_metadata === "object"
        ? (value.response_metadata as Record<string, unknown>)
        : {};
    cursor = typeof metadata.next_cursor === "string" ? metadata.next_cursor : "";
    if (!cursor) break;
  }
  return channels.slice(0, 200);
}

function selectedChannelIds(connection: ContentConnection) {
  const value = z
    .object({ ids: z.array(z.string().trim().min(1).max(500)).max(100).default([]) })
    .safeParse(connection.selectedResources);
  return new Set(value.success ? value.data.ids : []);
}

function slackTimestamp(value: string) {
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : null;
}

export function createSlackAdapter(dependencies?: {
  fetch?: typeof fetch;
  decrypt?: (value: string) => Promise<string>;
  refreshAccessToken?: (connection: ContentConnection) => Promise<string>;
  now?: () => Date;
}): ContentProviderAdapter {
  const fetcher = dependencies?.fetch || fetch;
  const decrypt =
    dependencies?.decrypt || ((value: string) => decryptServerSecret(value, "content"));
  const refreshAccessToken =
    dependencies?.refreshAccessToken ||
    ((connection) => refreshSlackAccessToken(connection, fetcher));
  const now = dependencies?.now || (() => new Date());
  async function accessToken(connection: ContentConnection) {
    if (!connection.accessTokenCiphertext) throw new ContentProviderAuthError("Reconnect Slack.");
    const expiresAt = connection.tokenExpiresAt
      ? new Date(connection.tokenExpiresAt).getTime()
      : null;
    return expiresAt !== null && expiresAt <= now().getTime() + 60_000
      ? refreshAccessToken(connection)
      : decrypt(connection.accessTokenCiphertext);
  }
  return {
    provider: "slack",
    async listResources(connection) {
      const channels = await joinedPublicChannels(await accessToken(connection), fetcher);
      return channels.map((channel) => ({
        id: channel.id,
        name: `#${channel.name}`,
        type: "public_channel",
      }));
    },
    async sync(connection) {
      const token = await accessToken(connection);
      const channels = await joinedPublicChannels(token, fetcher);
      const selected = selectedChannelIds(connection);
      const records: unknown[] = [];
      for (const channel of channels.filter((item) => selected.has(item.id)).slice(0, 20)) {
        let cursor = "";
        for (let page = 0; page < 2; page += 1) {
          const oldest = connection.syncCursor
            ? String(new Date(connection.syncCursor).getTime() / 1_000)
            : "";
          const value = await slackRequest(
            token,
            "conversations.history",
            {
              channel: channel.id,
              limit: "100",
              ...(oldest ? { oldest } : {}),
              ...(cursor ? { cursor } : {}),
            },
            fetcher,
          );
          const messages = Array.isArray(value.messages) ? value.messages : [];
          for (const item of messages) {
            if (!item || typeof item !== "object") continue;
            const message = item as Record<string, unknown>;
            if (typeof message.ts !== "string" || typeof message.text !== "string") continue;
            records.push({
              provider: "slack",
              externalItemId: `${channel.id}:${message.ts}`,
              type: "message",
              title: `#${channel.name} update`,
              text: message.text,
              sourceUrl: `https://app.slack.com/client/${encodeURIComponent(connection.externalAccountId)}/${encodeURIComponent(channel.id)}/thread/${message.ts.replace(".", "")}`,
              occurredAt: slackTimestamp(message.ts),
              metadata: {
                channelId: channel.id,
                channelName: channel.name,
                userId: message.user || null,
              },
            });
          }
          const metadata =
            value.response_metadata && typeof value.response_metadata === "object"
              ? (value.response_metadata as Record<string, unknown>)
              : {};
          cursor = typeof metadata.next_cursor === "string" ? metadata.next_cursor : "";
          if (!cursor) break;
        }
      }
      return { records, cursor: now().toISOString(), warnings: [] };
    },
  };
}
