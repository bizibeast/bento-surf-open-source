/* eslint-disable @typescript-eslint/no-explicit-any -- The connection grant columns ship additively. */
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadContentConnectionForUser } from "./content-connections.server";
import { requireContentWorkspace } from "./content-access.server";
import { externalToolsEnabled } from "./external-tools.server";
import { createGranolaAdapter, granolaReady } from "./granola-content.server";
import { enforceRequestRateLimit, RequestHttpError } from "./request-security.server";

const db = supabaseAdmin as any;
const consentColumns = "id,display_name,selected_resources,mcp_folders_enabled";
const consentSchema = z.object({
  id: z.uuid(),
  display_name: z.string().nullable(),
  selected_resources: z.unknown(),
  mcp_folders_enabled: z.boolean(),
});
const selectedResources = z.object({ ids: z.array(z.string().min(1).max(500)).max(100) });

function selectedFolders(value: unknown) {
  const result = selectedResources.safeParse(value);
  return new Set((result.success ? result.data.ids : []).filter((id) => id !== "all"));
}

export function granolaGatewayEnabled() {
  return externalToolsEnabled() && granolaReady();
}

function canUseGranolaGateway(workspaceId: string, authUserId: string) {
  return granolaGatewayEnabled() && workspaceId === authUserId;
}

async function requireGranolaGateway(workspaceId: string, authUserId: string) {
  if (!canUseGranolaGateway(workspaceId, authUserId))
    throw new RequestHttpError(403, "Granola delegation is available in your personal workspace.");
  await requireContentWorkspace(workspaceId);
}

function granolaRows(workspaceId: string) {
  return db
    .from("content_connections")
    .select(consentColumns)
    .eq("user_id", workspaceId)
    .eq("provider", "granola")
    .eq("status", "active");
}

export async function listGranolaGatewayConnections(workspaceId: string, authUserId: string) {
  if (!canUseGranolaGateway(workspaceId, authUserId)) return { available: false, connections: [] };
  await requireContentWorkspace(workspaceId);
  const { data, error } = await granolaRows(workspaceId).limit(25);
  if (error) throw new Error("Granola delegation settings could not be loaded.");
  return {
    available: true,
    connections: consentSchema
      .array()
      .parse(data)
      .map((row) => ({
        id: row.id,
        name: row.display_name || "Granola connection",
        enabled: row.mcp_folders_enabled,
        hasSelectedFolders: selectedFolders(row.selected_resources).size > 0,
      })),
  };
}

export async function setGranolaGatewayPermission(
  workspaceId: string,
  authUserId: string,
  connectionId: string,
  enabled: boolean,
) {
  await requireGranolaGateway(workspaceId, authUserId);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "granola-mcp-permission", authUserId);
  const { data, error } = await granolaRows(workspaceId).eq("id", connectionId).maybeSingle();
  const row = consentSchema.safeParse(data);
  if (error || !row.success)
    throw new RequestHttpError(404, "The Granola connection is unavailable.");
  if (enabled && !selectedFolders(row.data.selected_resources).size)
    throw new RequestHttpError(400, "First choose which Granola folders Bento can use in Brain.");
  const updated = await db
    .from("content_connections")
    .update({ mcp_folders_enabled: enabled })
    .eq("user_id", workspaceId)
    .eq("id", connectionId)
    .eq("provider", "granola")
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (updated.error || !updated.data)
    throw new Error("The Granola permission could not be updated.");
  return { enabled };
}

export async function listGranolaGatewayFolders(
  workspaceId: string,
  authUserId: string,
  connectionId: string,
) {
  await requireGranolaGateway(workspaceId, authUserId);
  await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "granola-mcp-folders", authUserId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - 15_000).toISOString();
  const eligible = await db
    .from("content_connections")
    .update({ mcp_folders_last_attempt_at: now.toISOString() })
    .eq("user_id", workspaceId)
    .eq("id", connectionId)
    .eq("provider", "granola")
    .eq("status", "active")
    .eq("mcp_folders_enabled", true)
    .or(`mcp_folders_last_attempt_at.is.null,mcp_folders_last_attempt_at.lt.${cutoff}`)
    .select(consentColumns)
    .maybeSingle();
  const grant = consentSchema.safeParse(eligible.data);
  if (eligible.error || !grant.success)
    throw new RequestHttpError(409, "Granola delegation is unavailable or cooling down.");
  const selected = selectedFolders(grant.data.selected_resources);
  if (!selected.size) return { folders: [] };
  const connection = await loadContentConnectionForUser(workspaceId, connectionId);
  if (!connection || connection.provider !== "granola")
    throw new RequestHttpError(404, "The Granola connection is unavailable.");
  const resources = await createGranolaAdapter({ maximumResponseBytes: 512_000 }).listResources(
    connection,
  );
  const outcome = await db
    .from("content_connections")
    .update({ mcp_folders_last_success_at: new Date().toISOString() })
    .eq("user_id", workspaceId)
    .eq("id", connectionId)
    .eq("provider", "granola")
    .eq("status", "active")
    .eq("mcp_folders_enabled", true)
    .select(consentColumns)
    .maybeSingle();
  const latest = consentSchema.safeParse(outcome.data);
  if (outcome.error || !latest.success)
    throw new RequestHttpError(409, "Granola permission changed.");
  const allowed = selectedFolders(latest.data.selected_resources);
  return {
    folders: resources
      .filter(({ id, type }) => type === "folder" && selected.has(id) && allowed.has(id))
      .map(({ id, name }) => ({ id, name: name.slice(0, 160) })),
  };
}
