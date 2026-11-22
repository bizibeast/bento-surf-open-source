import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireStudioWorkspace } from "./content-studio.server";

// Existing tables are tenant-scoped before any document or receipt is read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any;
export async function loadContentCreationHistory(workspaceId: string, entryId: string) {
  z.uuid().parse(workspaceId);
  z.uuid().parse(entryId);
  await requireStudioWorkspace(workspaceId);
  const entry = await db
    .from("content_studio_entries")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", entryId)
    .maybeSingle();
  if (entry.error || !entry.data) throw new Error("This project's history is unavailable.");
  const receipt = await db
    .from("content_reference_drafts")
    .select("request_id,input")
    .eq("workspace_id", workspaceId)
    .eq("id", entryId)
    .maybeSingle();
  if (receipt.error) throw new Error("Creation history could not be loaded.");
  const requestId = z.uuid().safeParse(receipt.data?.request_id);
  const filter =
    `arguments->>id.eq.${entryId}` +
    (requestId.success ? `,arguments->>requestId.eq.${requestId.data}` : "");
  const actions = await db
    .from("content_agent_app_actions")
    .select("id,message_id,tool_name,status,created_at")
    .eq("user_id", workspaceId)
    .or(filter)
    .order("created_at", { ascending: true })
    .limit(20);
  if (actions.error) throw new Error("Creation history could not be loaded.");
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        message_id: z.uuid(),
        tool_name: z.string(),
        status: z.string(),
        created_at: z.string(),
      }),
    )
    .parse(actions.data || []);
  const messages = rows.length
    ? await db
        .from("content_agent_messages")
        .select("id,thread_id")
        .eq("user_id", workspaceId)
        .in(
          "id",
          rows.map((r) => r.message_id),
        )
        .gt("expires_at", new Date().toISOString())
        .limit(20)
    : { data: [], error: null };
  if (messages.error) throw new Error("Creation conversation could not be loaded.");
  const first = rows
    .map((r) => (messages.data || []).find((m: { id: string }) => m.id === r.message_id))
    .find(Boolean);
  const thread = z.uuid().safeParse(first?.thread_id);
  return {
    brief:
      typeof receipt.data?.input?.prompt === "string"
        ? receipt.data.input.prompt.slice(0, 3000)
        : null,
    conversationPath: thread.success ? `/content?tab=agent&thread=${thread.data}` : null,
    actions: rows.map((r) => ({
      id: r.id,
      tool: r.tool_name,
      status: r.status,
      createdAt: r.created_at,
    })),
  };
}
