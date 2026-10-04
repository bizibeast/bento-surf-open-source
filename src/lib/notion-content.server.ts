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

const NOTION_API = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2026-03-11";

function notionCredentials() {
  const clientId = process.env.NOTION_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.NOTION_CLIENT_SECRET?.trim() || "";
  const redirectUri =
    process.env.NOTION_REDIRECT_URI?.trim() ||
    `${(process.env.VITE_APP_URL?.trim() || "http://localhost:8080").replace(/\/$/, "")}/integrations/notion/callback`;
  if (!clientId || !clientSecret) throw new Error("Notion is not configured.");
  return { clientId, clientSecret, redirectUri };
}

export function notionReady() {
  try {
    notionCredentials();
    return isServerSecretEncryptionKeyValid(process.env.CONTENT_CONNECTION_ENCRYPTION_KEY);
  } catch {
    return false;
  }
}

export function notionAuthorizationUrl(state: string) {
  const { clientId, redirectUri } = notionCredentials();
  const url = new URL(`${NOTION_API}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
}

const notionTokenSchema = z
  .object({
    access_token: z.string().min(1).max(10_000),
    refresh_token: z.string().min(1).max(10_000).optional(),
    expires_in: z.number().int().positive().optional(),
    workspace_id: z.string().min(1).max(500),
    workspace_name: z.string().max(160).nullish(),
    workspace_icon: z.string().max(2_000).nullish(),
    bot_id: z.string().min(1).max(500),
    owner: z.unknown().optional(),
  })
  .passthrough();
export type NotionToken = z.infer<typeof notionTokenSchema>;

export async function exchangeNotionCode(
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<NotionToken> {
  const { clientId, clientSecret, redirectUri } = notionCredentials();
  const response = await fetcher(`${NOTION_API}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Notion authorization failed.");
  return notionTokenSchema.parse(await response.json());
}

async function saveNotionConnection(userId: string, token: NotionToken) {
  const db = supabaseAdmin as any;
  const { data: existing } = await db
    .from("content_connections")
    .select("selected_resources,sync_cursor")
    .eq("user_id", userId)
    .eq("provider", "notion")
    .eq("external_account_id", token.workspace_id)
    .maybeSingle();
  const owner =
    token.owner && typeof token.owner === "object" ? (token.owner as Record<string, unknown>) : {};
  const ownerUser =
    owner.user && typeof owner.user === "object" ? (owner.user as Record<string, unknown>) : {};
  const { error } = await db.from("content_connections").upsert(
    {
      user_id: userId,
      provider: "notion",
      external_account_id: token.workspace_id,
      display_name: token.workspace_name || "Notion workspace",
      status: "active",
      scopes: ["read_content"],
      selected_resources: existing?.selected_resources || { ids: [] },
      access_token_ciphertext: await encryptServerSecret(token.access_token, "content"),
      refresh_token_ciphertext: token.refresh_token
        ? await encryptServerSecret(token.refresh_token, "content")
        : null,
      token_expires_at: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1_000).toISOString()
        : null,
      metadata: {
        botId: token.bot_id,
        workspaceIcon: token.workspace_icon || null,
        ownerType: typeof owner.type === "string" ? owner.type : null,
        ownerId: typeof ownerUser.id === "string" ? ownerUser.id : null,
      },
      sync_cursor: existing?.sync_cursor || null,
      last_error: null,
    },
    { onConflict: "user_id,provider,external_account_id" },
  );
  if (error) throw new Error("Notion connection could not be saved.");
}

export async function completeNotionConnectionForUser(
  userId: string,
  input: { code: string; state: string },
  dependencies: {
    consumeState: typeof consumeContentOAuthState;
    exchange: typeof exchangeNotionCode;
    save: (userId: string, token: NotionToken) => Promise<unknown>;
  } = {
    consumeState: consumeContentOAuthState,
    exchange: exchangeNotionCode,
    save: saveNotionConnection,
  },
) {
  const state = await dependencies.consumeState({ userId, provider: "notion", state: input.state });
  if (!state) throw new Error("This Notion connection expired. Start again.");
  const token = await dependencies.exchange(input.code);
  await dependencies.save(userId, token);
  return {
    workspaceId: token.workspace_id,
    displayName: token.workspace_name || "Notion workspace",
  };
}

async function notionRequest(
  token: string,
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
) {
  const response = await fetcher(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_API_VERSION,
      accept: "application/json",
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ContentProviderAuthError("Notion authorization expired. Reconnect Notion.");
  }
  if (!response.ok) throw new Error(`Notion request failed (${response.status}).`);
  return response.json() as Promise<Record<string, unknown>>;
}

function richText(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value
    .slice(0, 100)
    .map((item) =>
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).plain_text === "string"
        ? String((item as Record<string, unknown>).plain_text)
        : "",
    )
    .join("")
    .trim();
}

function pageTitle(page: Record<string, unknown>) {
  const properties =
    page.properties && typeof page.properties === "object"
      ? (page.properties as Record<string, unknown>)
      : {};
  for (const property of Object.values(properties)) {
    if (!property || typeof property !== "object") continue;
    const value = property as Record<string, unknown>;
    if (value.type === "title") {
      const title = richText(value.title);
      if (title) return title;
    }
  }
  return "Untitled Notion page";
}

function blockText(block: Record<string, unknown>) {
  const type = typeof block.type === "string" ? block.type : "";
  const value =
    type && block[type] && typeof block[type] === "object"
      ? (block[type] as Record<string, unknown>)
      : {};
  return (
    richText(value.rich_text) ||
    (typeof value.title === "string" ? value.title.trim() : "") ||
    (typeof value.caption === "string" ? value.caption.trim() : "")
  );
}

async function readPageBlocks(
  pageId: string,
  token: string,
  fetcher: typeof fetch,
  depth = 0,
  budget = { remaining: 200 },
): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const body = await notionRequest(
      token,
      `/blocks/${encodeURIComponent(pageId)}/children?${query}`,
      { method: "GET" },
      fetcher,
    );
    const results = Array.isArray(body.results) ? body.results : [];
    for (const item of results) {
      if (!item || typeof item !== "object" || budget.remaining <= 0) break;
      budget.remaining -= 1;
      const block = item as Record<string, unknown>;
      const text = blockText(block);
      if (text) lines.push(text);
      if (block.has_children === true && depth < 2 && typeof block.id === "string") {
        lines.push(...(await readPageBlocks(block.id, token, fetcher, depth + 1, budget)));
      }
    }
    cursor =
      body.has_more === true && typeof body.next_cursor === "string" ? body.next_cursor : null;
  } while (cursor && budget.remaining > 0);
  return lines;
}

function selectedPageIds(connection: ContentConnection) {
  const parsed = z
    .object({ ids: z.array(z.string().trim().min(1).max(500)).max(100).default([]) })
    .safeParse(connection.selectedResources);
  return parsed.success ? [...new Set(parsed.data.ids)] : [];
}

export function createNotionAdapter(dependencies?: {
  fetch?: typeof fetch;
  decrypt?: (value: string) => Promise<string>;
  now?: () => Date;
}): ContentProviderAdapter {
  const fetcher = dependencies?.fetch || fetch;
  const decrypt =
    dependencies?.decrypt || ((value: string) => decryptServerSecret(value, "content"));
  const now = dependencies?.now || (() => new Date());
  return {
    provider: "notion",
    async listResources(connection) {
      if (!connection.accessTokenCiphertext)
        throw new ContentProviderAuthError("Reconnect Notion.");
      const token = await decrypt(connection.accessTokenCiphertext);
      const resources: Array<{ id: string; name: string; type: string }> = [];
      let cursor: string | null = null;
      do {
        const body = await notionRequest(
          token,
          "/search",
          {
            method: "POST",
            body: JSON.stringify({
              filter: { property: "object", value: "page" },
              page_size: 100,
              ...(cursor ? { start_cursor: cursor } : {}),
            }),
          },
          fetcher,
        );
        const results = Array.isArray(body.results) ? body.results : [];
        for (const item of results) {
          if (!item || typeof item !== "object" || resources.length >= 200) continue;
          const page = item as Record<string, unknown>;
          if (page.object !== "page" || typeof page.id !== "string") continue;
          resources.push({ id: page.id, name: pageTitle(page), type: "page" });
        }
        cursor =
          body.has_more === true && typeof body.next_cursor === "string" ? body.next_cursor : null;
      } while (cursor && resources.length < 200);
      return resources;
    },
    async sync(connection) {
      if (!connection.accessTokenCiphertext)
        throw new ContentProviderAuthError("Reconnect Notion.");
      const token = await decrypt(connection.accessTokenCiphertext);
      const records: unknown[] = [];
      for (const pageId of selectedPageIds(connection)) {
        const page = await notionRequest(
          token,
          `/pages/${encodeURIComponent(pageId)}`,
          { method: "GET" },
          fetcher,
        );
        const lastEdited = typeof page.last_edited_time === "string" ? page.last_edited_time : null;
        if (lastEdited && connection.syncCursor && lastEdited <= connection.syncCursor) continue;
        const text = (await readPageBlocks(pageId, token, fetcher)).join("\n").slice(0, 20_000);
        records.push({
          provider: "notion",
          externalItemId: pageId,
          type: "page",
          title: pageTitle(page),
          text,
          sourceUrl: typeof page.url === "string" ? page.url : null,
          occurredAt: lastEdited,
          metadata: {},
        });
      }
      return { records, cursor: now().toISOString(), warnings: [] };
    },
  };
}
