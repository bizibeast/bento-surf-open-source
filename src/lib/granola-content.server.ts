import { z } from "zod";
/* eslint-disable @typescript-eslint/no-explicit-any -- Content connection rows ship with migrations. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  decryptServerSecret,
  encryptServerSecret,
  isServerSecretEncryptionKeyValid,
} from "./secret-crypto.server";
import { McpHttpClient, type McpTool } from "./mcp-http.server";
import {
  ContentProviderAuthError,
  consumeContentOAuthState,
  createContentOAuthState,
  type ContentConnection,
  type ContentProviderAdapter,
} from "./content-connections.server";

export const GRANOLA_MCP_ENDPOINT = "https://mcp.granola.ai/mcp";
const GRANOLA_PROTECTED_RESOURCE = "https://mcp.granola.ai/.well-known/oauth-protected-resource";

const protectedResourceSchema = z.object({
  authorization_servers: z.array(z.string().url()).min(1),
});
const authorizationMetadataSchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
});

export function granolaReady() {
  return isServerSecretEncryptionKeyValid(process.env.CONTENT_CONNECTION_ENCRYPTION_KEY);
}

export type GranolaOAuthMetadata = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
};

export async function discoverGranolaOAuth(
  fetcher: typeof fetch = fetch,
): Promise<GranolaOAuthMetadata> {
  const resourceResponse = await fetcher(GRANOLA_PROTECTED_RESOURCE, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resourceResponse.ok) throw new Error("Granola OAuth discovery failed.");
  const resource = protectedResourceSchema.parse(await resourceResponse.json());
  const issuer = resource.authorization_servers[0].replace(/\/$/, "");
  const metadataResponse = await fetcher(`${issuer}/.well-known/oauth-authorization-server`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!metadataResponse.ok) throw new Error("Granola authorization discovery failed.");
  const metadata = authorizationMetadataSchema.parse(await metadataResponse.json());
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint,
  };
}

export function granolaRedirectUri() {
  return (
    process.env.GRANOLA_REDIRECT_URI?.trim() ||
    `${(process.env.VITE_APP_URL?.trim() || "http://localhost:8080").replace(/\/$/, "")}/integrations/granola/callback`
  );
}

export function granolaAuthorizationUrl(input: {
  state: string;
  clientId: string;
  codeChallenge: string;
  authorizationEndpoint: string;
}) {
  const url = new URL(input.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: granolaRedirectUri(),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    resource: GRANOLA_MCP_ENDPOINT,
  }).toString();
  return url.toString();
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomGranolaVerifier() {
  return base64Url(crypto.getRandomValues(new Uint8Array(48)));
}

export async function granolaCodeChallenge(verifier: string) {
  return base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
}

export async function registerGranolaClient(
  registrationEndpoint: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(registrationEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Bento Content",
      redirect_uris: [granolaRedirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Granola client registration failed.");
  const value = z.object({ client_id: z.string().min(1).max(2_000) }).parse(await response.json());
  return { clientId: value.client_id };
}

type GranolaToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string;
};

const granolaTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(10_000),
  refresh_token: z.string().min(1).max(10_000).optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().max(2_000).optional(),
});

function granolaTokenFromResponse(value: unknown): GranolaToken {
  const token = granolaTokenResponseSchema.parse(value);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    expiresIn: token.expires_in || null,
    scope: token.scope || "mcp",
  };
}

export async function exchangeGranolaCode(
  input: {
    code: string;
    clientId: string;
    codeVerifier: string;
    tokenEndpoint: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<GranolaToken> {
  const response = await fetcher(input.tokenEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      redirect_uri: granolaRedirectUri(),
      code_verifier: input.codeVerifier,
      resource: GRANOLA_MCP_ENDPOINT,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Granola authorization failed.");
  return granolaTokenFromResponse(await response.json());
}

type GranolaMcpClient = {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

function toolValue(result: Record<string, unknown>) {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return { text };
    }
  }
  return {};
}

async function granolaAccountInfo(accessToken: string) {
  const client = new McpHttpClient({ endpoint: GRANOLA_MCP_ENDPOINT, accessToken });
  const value = toolValue(await client.callTool("get_account_info", {}));
  const email = typeof value.email === "string" ? value.email : "";
  const workspaceValue = value.active_workspace ?? value.workspace;
  const workspace =
    typeof workspaceValue === "string"
      ? workspaceValue
      : workspaceValue && typeof workspaceValue === "object"
        ? String(
            (workspaceValue as Record<string, unknown>).name ||
              (workspaceValue as Record<string, unknown>).title ||
              "Granola workspace",
          )
        : "Granola workspace";
  if (!email) throw new Error("Granola account information was unavailable.");
  return { email, workspace };
}

type GranolaConnectionSave = GranolaToken & {
  accountId: string;
  displayName: string;
  clientId: string;
  tokenEndpoint: string;
};

async function saveGranolaConnection(userId: string, value: GranolaConnectionSave) {
  const db = supabaseAdmin as any;
  const { data: existing } = await db
    .from("content_connections")
    .select("selected_resources,sync_cursor")
    .eq("user_id", userId)
    .eq("provider", "granola")
    .eq("external_account_id", value.accountId)
    .maybeSingle();
  const { error } = await db.from("content_connections").upsert(
    {
      user_id: userId,
      provider: "granola",
      external_account_id: value.accountId,
      display_name: value.displayName,
      status: "active",
      scopes: value.scope.split(/\s+/).filter(Boolean),
      selected_resources: existing?.selected_resources || { ids: ["all"] },
      access_token_ciphertext: await encryptServerSecret(value.accessToken, "content"),
      refresh_token_ciphertext: value.refreshToken
        ? await encryptServerSecret(value.refreshToken, "content")
        : null,
      token_expires_at: value.expiresIn
        ? new Date(Date.now() + value.expiresIn * 1_000).toISOString()
        : null,
      metadata: { clientId: value.clientId, tokenEndpoint: value.tokenEndpoint },
      sync_cursor: existing?.sync_cursor || null,
      last_error: null,
    },
    { onConflict: "user_id,provider,external_account_id" },
  );
  if (error) throw new Error("Granola connection could not be saved.");
}

export async function beginGranolaConnectionForUser(
  userId: string,
  dependencies: {
    discover: typeof discoverGranolaOAuth;
    register: typeof registerGranolaClient;
    encrypt: (value: string) => Promise<string>;
    createState: (input: {
      userId: string;
      provider: "granola";
      metadata: Record<string, unknown>;
    }) => Promise<string>;
    randomVerifier: () => string;
    challenge: (value: string) => Promise<string>;
  } = {
    discover: discoverGranolaOAuth,
    register: registerGranolaClient,
    encrypt: (value) => encryptServerSecret(value, "content"),
    createState: createContentOAuthState,
    randomVerifier: randomGranolaVerifier,
    challenge: granolaCodeChallenge,
  },
) {
  const metadata = await dependencies.discover();
  const client = await dependencies.register(metadata.registrationEndpoint);
  const verifier = dependencies.randomVerifier();
  const verifierCiphertext = await dependencies.encrypt(verifier);
  const state = await dependencies.createState({
    userId,
    provider: "granola",
    metadata: {
      clientId: client.clientId,
      tokenEndpoint: metadata.tokenEndpoint,
      verifierCiphertext,
    },
  });
  return {
    url: granolaAuthorizationUrl({
      state,
      clientId: client.clientId,
      codeChallenge: await dependencies.challenge(verifier),
      authorizationEndpoint: metadata.authorizationEndpoint,
    }),
  };
}

const granolaStateMetadataSchema = z.object({
  clientId: z.string().min(1).max(2_000),
  tokenEndpoint: z.string().url(),
  verifierCiphertext: z.string().min(1).max(10_000),
});

export async function completeGranolaConnectionForUser(
  userId: string,
  input: { code: string; state: string },
  dependencies: {
    consumeState: typeof consumeContentOAuthState;
    decrypt: (value: string) => Promise<string>;
    exchange: (input: {
      code: string;
      clientId: string;
      codeVerifier: string;
      tokenEndpoint: string;
    }) => Promise<GranolaToken>;
    accountInfo: (accessToken: string) => Promise<{ email: string; workspace: string }>;
    save: (userId: string, value: GranolaConnectionSave) => Promise<unknown>;
  } = {
    consumeState: consumeContentOAuthState,
    decrypt: (value) => decryptServerSecret(value, "content"),
    exchange: exchangeGranolaCode,
    accountInfo: granolaAccountInfo,
    save: saveGranolaConnection,
  },
) {
  const state = await dependencies.consumeState({
    userId,
    provider: "granola",
    state: input.state,
  });
  if (!state) throw new Error("This Granola connection expired. Start again.");
  const metadata = granolaStateMetadataSchema.parse(state.metadata);
  const token = await dependencies.exchange({
    code: input.code,
    clientId: metadata.clientId,
    codeVerifier: await dependencies.decrypt(metadata.verifierCiphertext),
    tokenEndpoint: metadata.tokenEndpoint,
  });
  const account = await dependencies.accountInfo(token.accessToken);
  const value: GranolaConnectionSave = {
    ...token,
    accountId: account.email,
    displayName: account.workspace,
    clientId: metadata.clientId,
    tokenEndpoint: metadata.tokenEndpoint,
  };
  await dependencies.save(userId, value);
  return { accountId: account.email, displayName: account.workspace };
}

async function refreshGranolaAccessToken(
  connection: ContentConnection,
  fetcher: typeof fetch = fetch,
) {
  if (!connection.refreshTokenCiphertext) throw new ContentProviderAuthError("Reconnect Granola.");
  const metadata = z
    .object({ clientId: z.string().min(1).max(2_000), tokenEndpoint: z.string().url() })
    .parse(connection.metadata);
  const response = await fetcher(metadata.tokenEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: await decryptServerSecret(connection.refreshTokenCiphertext, "content"),
      client_id: metadata.clientId,
      resource: GRANOLA_MCP_ENDPOINT,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ContentProviderAuthError("Granola authorization expired. Reconnect Granola.");
  }
  if (!response.ok) throw new Error("Granola token refresh failed.");
  const token = granolaTokenFromResponse(await response.json());
  const { error } = await (supabaseAdmin as any)
    .from("content_connections")
    .update({
      access_token_ciphertext: await encryptServerSecret(token.accessToken, "content"),
      ...(token.refreshToken
        ? { refresh_token_ciphertext: await encryptServerSecret(token.refreshToken, "content") }
        : {}),
      token_expires_at: token.expiresIn
        ? new Date(Date.now() + token.expiresIn * 1_000).toISOString()
        : null,
      status: "active",
      last_error: null,
    })
    .eq("id", connection.id)
    .eq("user_id", connection.userId)
    .eq("provider", "granola");
  if (error) throw new Error("Granola refreshed credentials could not be saved.");
  return token.accessToken;
}

function arrayFrom(value: Record<string, unknown>, key: string) {
  const nested = value[key];
  if (Array.isArray(nested)) return nested.filter((item) => item && typeof item === "object");
  return [];
}

function meetingId(value: Record<string, unknown>) {
  const id = value.id ?? value.meeting_id;
  return typeof id === "string" ? id : "";
}

function selectedFolderIds(connection: ContentConnection) {
  const parsed = z
    .object({ ids: z.array(z.string().trim().min(1).max(500)).max(100).default(["all"]) })
    .safeParse(connection.selectedResources);
  const ids = parsed.success ? parsed.data.ids : ["all"];
  return [...new Set(ids)].filter((id) => id !== "all");
}

export function createGranolaAdapter(dependencies?: {
  decrypt?: (value: string) => Promise<string>;
  refreshAccessToken?: (connection: ContentConnection) => Promise<string>;
  createClient?: (accessToken: string) => GranolaMcpClient;
  now?: () => Date;
}): ContentProviderAdapter {
  const decrypt =
    dependencies?.decrypt || ((value: string) => decryptServerSecret(value, "content"));
  const refreshAccessToken = dependencies?.refreshAccessToken || refreshGranolaAccessToken;
  const createClient =
    dependencies?.createClient ||
    ((accessToken: string) => new McpHttpClient({ endpoint: GRANOLA_MCP_ENDPOINT, accessToken }));
  const now = dependencies?.now || (() => new Date());

  async function clientFor(connection: ContentConnection) {
    if (!connection.accessTokenCiphertext) throw new ContentProviderAuthError("Reconnect Granola.");
    const expiresAt = connection.tokenExpiresAt
      ? new Date(connection.tokenExpiresAt).getTime()
      : null;
    const accessToken =
      expiresAt !== null && expiresAt <= now().getTime() + 60_000
        ? await refreshAccessToken(connection)
        : await decrypt(connection.accessTokenCiphertext);
    return createClient(accessToken);
  }

  return {
    provider: "granola",
    async listResources(connection) {
      const client = await clientFor(connection);
      const tools = await client.listTools();
      const resources = [{ id: "all", name: "All accessible meetings", type: "workspace" }];
      if (!tools.some((tool) => tool.name === "list_meeting_folders")) return resources;
      try {
        const value = toolValue(await client.callTool("list_meeting_folders", {}));
        for (const item of arrayFrom(value, "folders").slice(0, 100)) {
          const folder = item as Record<string, unknown>;
          if (typeof folder.id !== "string") continue;
          resources.push({
            id: folder.id,
            name: typeof folder.title === "string" ? folder.title : "Meeting folder",
            type: "folder",
          });
        }
      } catch {
        return resources;
      }
      return resources;
    },
    async sync(connection) {
      const client = await clientFor(connection);
      const tools = await client.listTools();
      const toolNames = new Set(tools.map((tool) => tool.name));
      if (!toolNames.has("list_meetings") || !toolNames.has("get_meetings")) {
        throw new Error("Granola meeting tools are unavailable.");
      }
      const folderIds = selectedFolderIds(connection);
      const list = toolValue(
        await client.callTool("list_meetings", folderIds.length ? { folder_ids: folderIds } : {}),
      );
      const summaries = arrayFrom(list, "meetings").slice(0, 50) as Record<string, unknown>[];
      const ids = summaries.map(meetingId).filter(Boolean);
      if (!ids.length) return { records: [], cursor: now().toISOString(), warnings: [] };
      const details = toolValue(await client.callTool("get_meetings", { meeting_ids: ids }));
      const detailRows = arrayFrom(details, "meetings") as Record<string, unknown>[];
      const byId = new Map(detailRows.map((meeting) => [meetingId(meeting), meeting]));
      const transcriptAvailable = toolNames.has("get_meeting_transcript");
      const warnings = transcriptAvailable ? [] : ["transcript_unavailable"];
      const records = [];
      for (const summary of summaries) {
        const id = meetingId(summary);
        const detail = byId.get(id) || summary;
        let transcript = "";
        if (transcriptAvailable && records.length < 10) {
          try {
            const result = toolValue(
              await client.callTool("get_meeting_transcript", { meeting_id: id }),
            );
            transcript =
              typeof result.transcript === "string"
                ? result.transcript
                : typeof result.text === "string"
                  ? result.text
                  : "";
          } catch {
            if (!warnings.includes("transcript_unavailable"))
              warnings.push("transcript_unavailable");
          }
        }
        const notes = [detail.notes, detail.summary, detail.private_notes]
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          .join("\n");
        records.push({
          provider: "granola",
          externalItemId: id,
          type: "meeting",
          title:
            (typeof detail.title === "string" && detail.title) ||
            (typeof summary.title === "string" && summary.title) ||
            "Granola meeting",
          text: [notes, transcript].filter(Boolean).join("\n\n"),
          sourceUrl:
            typeof detail.url === "string"
              ? detail.url
              : typeof summary.url === "string"
                ? summary.url
                : null,
          occurredAt:
            typeof detail.date === "string"
              ? detail.date
              : typeof summary.date === "string"
                ? summary.date
                : null,
          metadata: { attendees: detail.attendees || summary.attendees || [] },
        });
      }
      return { records, cursor: now().toISOString(), warnings };
    },
  };
}
