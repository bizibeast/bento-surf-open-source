/* eslint-disable @typescript-eslint/no-explicit-any -- Content tables ship with paired migrations. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  contentProviderSchema,
  contentSourceHash,
  normalizeContentSource,
  type ContentProvider,
  type NormalizedContentSource,
} from "./content-connections";

export type ContentConnection = {
  id: string;
  userId: string;
  provider: ContentProvider;
  externalAccountId: string;
  displayName: string | null;
  status: string;
  scopes: string[];
  selectedResources: Record<string, unknown>;
  metadata: Record<string, unknown>;
  syncCursor: string | null;
  accessTokenCiphertext: string | null;
  refreshTokenCiphertext: string | null;
  tokenExpiresAt: string | null;
};

export type ContentProviderResource = { id: string; name: string; type: string };
export type ContentProviderAdapter = {
  provider: ContentProvider;
  listResources(connection: ContentConnection): Promise<ContentProviderResource[]>;
  sync(connection: ContentConnection): Promise<{
    records: unknown[];
    cursor: string | null;
    warnings?: string[];
  }>;
};

export type ContentOAuthStateStore = {
  insert(row: {
    state: string;
    user_id: string;
    provider: ContentProvider;
    metadata: Record<string, unknown>;
    expires_at: string;
  }): Promise<void>;
  consume(input: {
    state: string;
    userId: string;
    provider: ContentProvider;
    now: string;
  }): Promise<{ metadata: Record<string, unknown> } | null>;
};

const defaultStateStore: ContentOAuthStateStore = {
  async insert(row) {
    const { error } = await (supabaseAdmin as any).from("content_connection_states").insert(row);
    if (error) throw new Error("The provider connection could not be started.");
  },
  async consume({ state, userId, provider, now }) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_connection_states")
      .delete()
      .eq("state", state)
      .eq("user_id", userId)
      .eq("provider", provider)
      .gt("expires_at", now)
      .select("metadata")
      .maybeSingle();
    if (error) throw new Error("The provider connection state could not be consumed.");
    return data ? { metadata: (data.metadata || {}) as Record<string, unknown> } : null;
  },
};

export async function createContentOAuthState(
  input: {
    userId: string;
    provider: ContentProvider;
    metadata?: Record<string, unknown>;
  },
  store: ContentOAuthStateStore = defaultStateStore,
  now = new Date(),
) {
  const provider = contentProviderSchema.parse(input.provider);
  const state = crypto.randomUUID();
  await store.insert({
    state,
    user_id: input.userId,
    provider,
    metadata: input.metadata || {},
    expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
  });
  return state;
}

export function consumeContentOAuthState(
  input: { userId: string; provider: ContentProvider; state: string },
  store: ContentOAuthStateStore = defaultStateStore,
  now = new Date(),
) {
  return store.consume({
    state: input.state,
    userId: input.userId,
    provider: contentProviderSchema.parse(input.provider),
    now: now.toISOString(),
  });
}

function connectionFromRow(row: any): ContentConnection {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: contentProviderSchema.parse(row.provider),
    externalAccountId: String(row.external_account_id),
    displayName: (row.display_name as string | null) || null,
    status: String(row.status),
    scopes: (row.scopes || []) as string[],
    selectedResources: (row.selected_resources || {}) as Record<string, unknown>,
    metadata: (row.metadata || {}) as Record<string, unknown>,
    syncCursor: (row.sync_cursor as string | null) || null,
    accessTokenCiphertext: (row.access_token_ciphertext as string | null) || null,
    refreshTokenCiphertext: (row.refresh_token_ciphertext as string | null) || null,
    tokenExpiresAt: (row.token_expires_at as string | null) || null,
  };
}

export type ContentSyncStore = {
  loadConnection(userId: string, connectionId: string): Promise<ContentConnection | null>;
  markAttempt(userId: string, connectionId: string): Promise<unknown>;
  upsertSources(rows: Array<Record<string, unknown>>): Promise<unknown>;
  complete(
    userId: string,
    connectionId: string,
    result: { cursor: string | null; imported: number; warnings: string[] },
  ): Promise<unknown>;
  fail(userId: string, connectionId: string, error: string, expired: boolean): Promise<unknown>;
};

const defaultSyncStore: ContentSyncStore = {
  async loadConnection(userId, connectionId) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_connections")
      .select("*")
      .eq("id", connectionId)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw new Error("The Content connection could not be loaded.");
    return data ? connectionFromRow(data) : null;
  },
  async markAttempt(userId, connectionId) {
    const { error } = await (supabaseAdmin as any)
      .from("content_connections")
      .update({ last_attempt_at: new Date().toISOString(), last_error: null })
      .eq("id", connectionId)
      .eq("user_id", userId);
    if (error) throw new Error("The Content sync could not be started.");
  },
  async upsertSources(rows) {
    if (!rows.length) return;
    const { error } = await (supabaseAdmin as any)
      .from("content_source_records")
      .upsert(rows, { onConflict: "connection_id,external_item_id" });
    if (error) throw new Error("Imported Content sources could not be saved.");
  },
  async complete(userId, connectionId, result) {
    const { error } = await (supabaseAdmin as any)
      .from("content_connections")
      .update({
        sync_cursor: result.cursor,
        last_success_at: new Date().toISOString(),
        last_error: result.warnings[0]?.slice(0, 1_000) || null,
        status: "active",
      })
      .eq("id", connectionId)
      .eq("user_id", userId);
    if (error) throw new Error("The Content sync result could not be saved.");
  },
  async fail(userId, connectionId, error, expired) {
    await (supabaseAdmin as any)
      .from("content_connections")
      .update({ last_error: error.slice(0, 1_000), ...(expired ? { status: "expired" } : {}) })
      .eq("id", connectionId)
      .eq("user_id", userId);
  },
};

export function loadContentConnectionForUser(userId: string, connectionId: string) {
  return defaultSyncStore.loadConnection(userId, connectionId);
}

const defaultSelectionStore = {
  loadConnection: defaultSyncStore.loadConnection,
  async updateSelection(userId: string, connectionId: string, value: { ids: string[] }) {
    const { error } = await (supabaseAdmin as any)
      .from("content_connections")
      .update({ selected_resources: value, sync_cursor: null, last_error: null })
      .eq("id", connectionId)
      .eq("user_id", userId)
      .eq("status", "active");
    if (error) throw new Error("Content source selection could not be saved.");
  },
};

export class ContentProviderAuthError extends Error {}

export async function syncContentConnectionWithAdapter(
  userId: string,
  connectionId: string,
  adapter: ContentProviderAdapter,
  store: ContentSyncStore = defaultSyncStore,
) {
  const connection = await store.loadConnection(userId, connectionId);
  if (!connection) throw new Error("Content connection not found.");
  if (connection.provider !== adapter.provider) throw new Error("Content provider mismatch.");
  await store.markAttempt(userId, connectionId);
  try {
    const result = await adapter.sync(connection);
    const records = result.records.map(normalizeContentSource);
    if (records.some((record) => record.provider !== connection.provider)) {
      throw new Error("Content provider returned mismatched records.");
    }
    const now = new Date().toISOString();
    const rows = await Promise.all(
      records.map(async (record) => ({
        user_id: userId,
        connection_id: connection.id,
        provider: record.provider,
        external_item_id: record.externalItemId,
        record_type: record.type,
        title: record.title,
        body: record.text,
        canonical_source_url: record.sourceUrl,
        occurred_at: record.occurredAt,
        retrieved_at: now,
        content_hash: await contentSourceHash(record),
        metadata: record.metadata,
        deleted_at: null,
      })),
    );
    await store.upsertSources(rows);
    const warnings = (result.warnings || []).slice(0, 20).map((warning) => warning.slice(0, 1_000));
    await store.complete(userId, connectionId, {
      cursor: result.cursor,
      imported: rows.length,
      warnings,
    });
    return { imported: rows.length, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Content sync failed.";
    await store.fail(userId, connectionId, message, error instanceof ContentProviderAuthError);
    throw error;
  }
}

export async function updateContentResourceSelectionWithAdapter(
  userId: string,
  connectionId: string,
  resourceIds: string[],
  adapter: ContentProviderAdapter,
  store: Pick<ContentSyncStore, "loadConnection"> & {
    updateSelection(
      userId: string,
      connectionId: string,
      value: { ids: string[] },
    ): Promise<unknown>;
  } = defaultSelectionStore,
) {
  const connection = await store.loadConnection(userId, connectionId);
  if (!connection) throw new Error("Content connection not found.");
  if (connection.provider !== adapter.provider) throw new Error("Content provider mismatch.");
  const resources = await adapter.listResources(connection);
  const available = new Set(resources.map((resource) => resource.id));
  const ids = [...new Set(resourceIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (ids.some((id) => !available.has(id)))
    throw new Error("A selected resource is not available.");
  await store.updateSelection(userId, connectionId, { ids });
  return { selected: ids.length };
}

export type ContentDataStore = {
  disconnect(userId: string, connectionId: string): Promise<boolean>;
  deleteSources(userId: string, connectionId: string): Promise<unknown>;
  deleteBrain(userId: string, connectionId: string, includeConfirmed: boolean): Promise<unknown>;
  deleteConnection(userId: string, connectionId: string): Promise<boolean>;
};

const defaultDataStore: ContentDataStore = {
  async disconnect(userId, connectionId) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_connections")
      .update({
        status: "disconnected",
        access_token_ciphertext: null,
        refresh_token_ciphertext: null,
        token_expires_at: null,
        last_error: null,
      })
      .eq("id", connectionId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("The Content connection could not be disconnected.");
    return Boolean(data);
  },
  async deleteSources(userId, connectionId) {
    const { error } = await (supabaseAdmin as any)
      .from("content_source_records")
      .delete()
      .eq("user_id", userId)
      .eq("connection_id", connectionId);
    if (error) throw new Error("Imported Content sources could not be deleted.");
  },
  async deleteBrain(userId, connectionId, includeConfirmed) {
    let query = (supabaseAdmin as any)
      .from("creator_brain_items")
      .delete()
      .eq("user_id", userId)
      .eq("provenance", "integration")
      .like("source_ref", `integration:${connectionId}:%`);
    if (!includeConfirmed) query = query.eq("status", "suggested");
    const { error } = await query;
    if (error) throw new Error("Provider-derived Brain items could not be deleted.");
  },
  async deleteConnection(userId, connectionId) {
    const { data, error } = await (supabaseAdmin as any)
      .from("content_connections")
      .delete()
      .eq("id", connectionId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("The Content connection could not be deleted.");
    return Boolean(data);
  },
};

export async function disconnectContentConnectionForUser(
  userId: string,
  connectionId: string,
  store: ContentDataStore = defaultDataStore,
) {
  if (!(await store.disconnect(userId, connectionId)))
    throw new Error("Content connection not found.");
  return { disconnected: true as const };
}

export async function deleteContentConnectionDataForUser(
  userId: string,
  connectionId: string,
  includeConfirmedBrain: boolean,
  store: ContentDataStore = defaultDataStore,
) {
  await store.deleteSources(userId, connectionId);
  await store.deleteBrain(userId, connectionId, includeConfirmedBrain);
  if (includeConfirmedBrain && !(await store.deleteConnection(userId, connectionId))) {
    throw new Error("Content connection not found.");
  }
  return { deleted: true as const, includeConfirmedBrain };
}

export function normalizeContentSourceRows(records: unknown[]): NormalizedContentSource[] {
  return records.map(normalizeContentSource);
}
