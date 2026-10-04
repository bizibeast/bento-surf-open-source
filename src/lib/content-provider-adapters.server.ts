import type { ContentProvider } from "./content-connections";
import type { ContentProviderAdapter } from "./content-connections.server";
import { createNotionAdapter } from "./notion-content.server";
import { createGranolaAdapter } from "./granola-content.server";
import { createGitHubAdapter } from "./github-content.server";
import { createSlackAdapter } from "./slack-content.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncContentConnectionWithAdapter } from "./content-connections.server";

export function getContentProviderAdapter(provider: ContentProvider): ContentProviderAdapter {
  switch (provider) {
    case "notion":
      return createNotionAdapter();
    case "granola":
      return createGranolaAdapter();
    case "github":
      return createGitHubAdapter();
    case "slack":
      return createSlackAdapter();
  }
}

export async function syncActiveContentConnectionsForUser(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("content_connections")
    .select("id,provider")
    .eq("user_id", userId)
    .eq("status", "active")
    .in("provider", ["notion", "granola", "github", "slack"]);
  if (error) throw new Error("Knowledge connections could not be loaded.");
  let succeeded = 0;
  let failed = 0;
  for (const row of data || []) {
    try {
      const provider = row.provider as ContentProvider;
      await syncContentConnectionWithAdapter(userId, row.id, getContentProviderAdapter(provider));
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  return { succeeded, failed };
}
