import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { analyticsPostReferenceSchema } from "./content-discover-post-context";
import {
  loadAnalyticsPostSource,
  saveAnalyticsPostSource,
} from "./content-discover-post-context.server";

export const getAnalyticsPostHandoff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => analyticsPostReferenceSchema.parse(input))
  .handler(async ({ context, data }) => {
    const post = await loadAnalyticsPostSource(context.workspaceId, data);
    return { title: post.title, summary: post.summary, url: post.source_url };
  });

export const saveAnalyticsPostToResearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => analyticsPostReferenceSchema.parse(input))
  .handler(({ context, data }) => saveAnalyticsPostSource(context.workspaceId, data));
