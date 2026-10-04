import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizePlan, type PlanId } from "./plans";

export const WORKSPACE_COOKIE = "bento_workspace";

export type WorkspaceSummary = {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  status: "pending" | "active" | "locked";
  plan: PlanId;
};

export type WorkspaceSession = {
  authUserId: string;
  workspaceId: string;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  appTheme: "light" | "dark";
};

export class WorkspaceAccessError extends Error {
  constructor() {
    super("No active Bento workspace is available.");
    this.name = "WorkspaceAccessError";
  }
}

type WorkspaceProfile = {
  id: string;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  workspace_status: WorkspaceSummary["status"];
  plan_id: string | null;
};

type MembershipRow = {
  workspace_id: string;
  created_at: string;
  profiles: WorkspaceProfile | WorkspaceProfile[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function signingKey(secret: string) {
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32)
    throw new Error("WORKSPACE_COOKIE_SIGNING_KEY must be at least 32 bytes.");
  return bytes;
}

export function workspaceCookieSigningKey() {
  const key = process.env.WORKSPACE_COOKIE_SIGNING_KEY?.trim();
  if (!key) throw new Error("Missing WORKSPACE_COOKIE_SIGNING_KEY.");
  signingKey(key);
  return key;
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    signingKey(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function signWorkspaceCookie(workspaceId: string, secret: string) {
  if (!UUID.test(workspaceId)) throw new Error("Invalid workspace ID.");
  const payload = `v1.${workspaceId}`;
  return `${payload}.${encodeBase64Url(await signature(payload, secret))}`;
}

export async function verifyWorkspaceCookie(value: string, secret: string) {
  const [version, workspaceId, encodedSignature, extra] = value.split(".");
  if (version !== "v1" || !UUID.test(workspaceId ?? "") || !encodedSignature || extra) return null;
  try {
    const expected = await signature(`${version}.${workspaceId}`, secret);
    return equalBytes(decodeBase64Url(encodedSignature), expected) ? workspaceId : null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WORKSPACE_COOKIE_SIGNING_KEY")) {
      throw error;
    }
    return null;
  }
}

export async function resolveWorkspace(
  authUserId: string,
  requestedId?: string | null,
): Promise<WorkspaceSession> {
  // New tables land before regenerated Supabase types in deployment order.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const [membershipResult, preferenceResult] = await Promise.all([
    db
      .from("workspace_memberships")
      .select(
        "workspace_id, created_at, profiles!inner(id, username, display_name, avatar_url, workspace_status, plan_id)",
      )
      .eq("auth_user_id", authUserId)
      .eq("role", "owner")
      .eq("status", "active")
      .order("created_at", { ascending: true }),
    db.from("account_preferences").select("app_theme").eq("auth_user_id", authUserId).maybeSingle(),
  ]);
  if (membershipResult.error) throw new Error(membershipResult.error.message);
  if (preferenceResult.error) throw new Error(preferenceResult.error.message);

  const workspaces = ((membershipResult.data ?? []) as MembershipRow[]).flatMap((membership) => {
    const profile = Array.isArray(membership.profiles)
      ? membership.profiles[0]
      : membership.profiles;
    if (!profile) return [];
    return [
      {
        id: profile.id,
        username: profile.username,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        status: profile.workspace_status,
        plan: normalizePlan(profile.plan_id),
      } satisfies WorkspaceSummary,
    ];
  });
  const active = workspaces.filter((workspace) => workspace.status === "active");
  const workspace = active.find((candidate) => candidate.id === requestedId) ?? active[0];
  if (!workspace) throw new WorkspaceAccessError();

  return {
    authUserId,
    workspaceId: workspace.id,
    workspace,
    workspaces,
    appTheme: preferenceResult.data?.app_theme === "dark" ? "dark" : "light",
  };
}
