import { onboardingDb as db } from "./session.server";

/** Owner-authenticated export stays available after paid editing access ends. */
export async function readOnboardingExport(workspaceId: string) {
  async function rows(table: string, columns: string) {
    const result: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db
        .from(table)
        .select(columns)
        .eq("user_id", workspaceId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + 499);
      if (page.error) throw new Error("Your export could not be prepared. Please try again.");
      result.push(...(page.data ?? []));
      if (!page.data || page.data.length < 500) return result;
    }
  }
  const [brain, threads, messages] = await Promise.all([
    rows("creator_brain_items", "id,kind,title,content,status,locked,created_at,updated_at"),
    rows("content_agent_threads", "id,title,created_at,updated_at"),
    rows("content_agent_messages", "id,thread_id,role,content,payload,created_at"),
  ]);
  return {
    format: "bento-content-export-v1",
    exportedAt: new Date().toISOString(),
    brain,
    threads,
    messages,
  };
}
