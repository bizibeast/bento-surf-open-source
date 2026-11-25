import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { setResponseHeader } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveWorkspace } from "./workspace-session.server";
import { enforceRequestRateLimit, RequestHttpError } from "./request-security.server";
import { loadPostStatsConnections, readWorkspacePostStats } from "./post-stats-connected.server";

export const getPostStatsAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    return {
      workspaceId: context.workspaceId,
      linkedInAnalyticsApproved: process.env.LINKEDIN_ANALYTICS_ACCESS_APPROVED === "true",
      workspaces: context.workspaceSession.workspaces
        .filter((row) => row.status === "active")
        .map((row) => ({ id: row.id, name: row.displayName || row.username || "Workspace" })),
      accounts: (await loadPostStatsConnections(context.workspaceId))
        .filter((row) => row.provider !== "facebook")
        .map((row) => ({
          provider: row.provider,
          handle: row.provider_handle,
          analyticsReady:
            row.provider === "instagram"
              ? row.scopes.includes("instagram_business_manage_insights") ||
                row.scopes.includes("instagram_manage_insights")
              : row.scopes.includes("r_member_postAnalytics") &&
                row.scopes.includes("r_member_social"),
        })),
    };
  });

export const getWorkspacePostStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ url: z.string().min(1).max(2048), workspaceId: z.uuid().optional() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const selectedId = data.workspaceId || context.workspaceId;
    const session = await resolveWorkspace(context.authUserId, selectedId);
    if (session.workspaceId !== selectedId || session.workspace.status !== "active")
      throw new RequestHttpError(403, "Workspace is unavailable.");
    await enforceRequestRateLimit(
      "FREE_TOOLS_MEDIA_RATE_LIMITER",
      "connected-post-stats",
      selectedId,
    );
    return readWorkspacePostStats(data.url, selectedId);
  });
