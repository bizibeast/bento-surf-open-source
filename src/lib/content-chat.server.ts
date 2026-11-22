import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireStudioWorkspace } from "./content-studio.server";
import { studioEntrySchema } from "./content-studio";

export async function readChatContentEntry(workspaceId: string, entryId: string) {
  z.uuid().parse(workspaceId);
  z.uuid().parse(entryId);
  await requireStudioWorkspace(workspaceId);
  // Additive content tables are validated here until the generated DB types catch up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const { data, error } = await db
    .from("content_studio_entries")
    .select("id,kind,title,document,revision")
    .eq("workspace_id", workspaceId)
    .eq("id", entryId)
    .maybeSingle();
  if (error || !data) throw new Error("This content is unavailable.");
  return studioEntrySchema.parse(data);
}
