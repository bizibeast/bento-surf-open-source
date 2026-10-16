/* eslint-disable @typescript-eslint/no-explicit-any -- RPC rows ship with the Content identity migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface ContentAgentPreferences {
  user_id: string;
  display_name: string;
  proactive_paused: boolean;
  generate_images: boolean;
  use_face_references: boolean;
  reference_photo_ids?: string[];
  branding?: import("./content-agent-branding").AgentBranding;
  destination_accounts?: Partial<Record<"twitter" | "linkedin" | "instagram", string>>;
  platforms: Array<"twitter" | "linkedin" | "instagram">;
}
export interface ContentAgentThread {
  id: string;
  user_id: string;
  title: string;
  kind: "agent" | "chat";
  pinned_at: string | null;
  last_read_at: string | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  unread_count: number;
}
export interface ContentAgentIdentity {
  thread: ContentAgentThread;
  preferences: ContentAgentPreferences;
}
export interface ContentAgentThreadCursor {
  pinnedAt: string | null;
  lastMessageAt: string;
  id: string;
}
export interface ContentAgentThreadPage {
  agent: ContentAgentThread;
  chats: ContentAgentThread[];
  nextCursor: ContentAgentThreadCursor | null;
}

/** Trusted server callers supply the already resolved workspace ID, never a request payload owner. */
export async function getOrCreateNamedAgentThreadForWorkspace(
  workspaceId: string,
): Promise<ContentAgentIdentity> {
  const { data, error } = await (supabaseAdmin as any).rpc("ensure_content_named_agent", {
    p_user_id: workspaceId,
  });
  if (error || !data) throw new Error("Agent identity could not be loaded.");
  return data;
}

export async function getContentAgentPreferencesForWorkspace(
  workspaceId: string,
): Promise<ContentAgentPreferences> {
  return (await getOrCreateNamedAgentThreadForWorkspace(workspaceId)).preferences;
}

export async function listContentAgentThreadsForWorkspace(
  workspaceId: string,
  input: { cursor?: ContentAgentThreadCursor | null; limit?: number } = {},
): Promise<ContentAgentThreadPage> {
  const { data, error } = await (supabaseAdmin as any).rpc("list_content_agent_threads_page", {
    p_user_id: workspaceId,
    p_limit: input.limit ?? 50,
    p_cursor: input.cursor ?? null,
  });
  if (error || !data) throw new Error("Agent conversations could not be loaded.");
  return data;
}
