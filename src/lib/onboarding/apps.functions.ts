import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { hasPlanEntitlement } from "../plan.server";
import { APP_GUIDES } from "./apps";
import { onboardingDb as db } from "./session.server";
const appInput = z.object({
  appId: z.string().refine((id) => APP_GUIDES.some((app) => app.id === id)),
});
async function exists(
  workspaceId: string,
  table: string,
  column = "user_id",
  filters: Record<string, unknown> = {},
) {
  let query = db.from(table).select("*", { count: "exact", head: true }).eq(column, workspaceId);
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const result = await query;
  if (result.error)
    throw new Error("Setup status is temporarily unavailable. Your app is still available below.");
  return result.count > 0;
}
export const getAppGuide = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => appInput.parse(input))
  .handler(async ({ context, data }) => {
    const app = APP_GUIDES.find((item) => item.id === data.appId)!;
    const userId = context.userId;
    const [profile, progress, session, allowed] = await Promise.all([
      db
        .from("profiles")
        .select("display_name,bio,onboarded,page_published,account_timezone,billing_catalog")
        .eq("id", userId)
        .single(),
      db
        .from("app_onboarding_progress")
        .select("dismissed_at,completed_at,first_result_at")
        .eq("workspace_id", userId)
        .eq("app_id", app.id)
        .maybeSingle(),
      db
        .from("onboarding_sessions")
        .select("brief,status")
        .eq("workspace_id", userId)
        .maybeSingle(),
      app.entitlement ? hasPlanEntitlement(userId, app.entitlement) : Promise.resolve(true),
    ]);
    if (profile.error || progress.error || session.error)
      throw new Error("Your setup guide could not be loaded.");
    const provider = app.id.endsWith("_dm") ? app.id.replace("_dm", "") : null;
    const product = (kind?: string, published = false) =>
      exists(userId, "commerce_products", "creator_id", {
        ...(kind ? { kind } : {}),
        ...(published ? { status: "published" } : {}),
      });
    const brain = (kind?: string) =>
      exists(userId, "creator_brain_items", "user_id", {
        status: "confirmed",
        ...(kind ? { kind } : {}),
      });
    const dm = async (enabled: boolean) =>
      (
        await Promise.all(
          ["instagram", "facebook", "twitter"].map((p) =>
            exists(userId, `${p}_dm_automations`, "user_id", enabled ? { enabled: true } : {}),
          ),
        )
      ).some(Boolean);
    async function proof(key: string): Promise<boolean> {
      switch (key) {
        case "profile":
          return Boolean(profile.data.display_name);
        case "timezone":
          return Boolean(profile.data.account_timezone);
        case "published":
          return Boolean(profile.data.onboarded && profile.data.page_published);
        case "block":
          return exists(userId, "blocks");
        case "billing":
          return exists(userId, "subscriptions");
        case "product":
          return product();
        case "payments":
          return exists(userId, "creator_payment_accounts", "creator_id", {
            onboarding_status: "complete",
            charges_enabled: true,
          });
        case "published_product":
          return product(undefined, true);
        case "priority_draft":
          return product("priority_dm");
        case "priority_live":
          return product("priority_dm", true);
        case "community_draft":
          return product("paid_community");
        case "community_live":
          return product("paid_community", true);
        case "community_post":
          return exists(userId, "commerce_community_posts", "creator_id");
        case "calendar":
          return exists(userId, "booking_calendar_connections", "user_id", { status: "active" });
        case "availability":
          return exists(userId, "booking_availability", "creator_id");
        case "booking_live":
          return product("coaching_call", true);
        case "content_profile":
          return exists(userId, "creator_content_profiles");
        case "social":
          return exists(userId, "social_connections", "user_id", { status: "active" });
        case "social_draft":
          return exists(userId, "social_posts");
        case "scheduled":
          return exists(userId, "social_posts", "user_id", { status: "scheduled" });
        case "snapshot":
          return exists(userId, "social_analytics_snapshots");
        case "insight":
          return exists(userId, "social_content_insights");
        case "recommendation":
          return exists(userId, "creator_content_recommendations");
        case "saved_recommendation":
          return exists(userId, "creator_content_recommendations", "user_id", {
            feedback: "saved",
          });
        case "brain_profile":
          return brain("profile");
        case "brain_voice":
          return brain("instruction");
        case "brain_strategy":
          return brain("strategy");
        case "brain":
          return (
            await Promise.all([brain("profile"), brain("instruction"), brain("strategy")])
          ).every(Boolean);
        case "assistant":
          return exists(userId, "content_agent_messages", "user_id", { role: "assistant" });
        case "routine":
          return exists(userId, "content_routines", "user_id", { enabled: true });
        case "routine_result":
          return exists(userId, "content_routine_runs", "user_id", { status: "succeeded" });
        case "publication":
          return exists(userId, "newsletter_publications", "creator_id");
        case "issue":
          return exists(userId, "audience_campaigns", "creator_id");
        case "published_issue":
          return exists(userId, "audience_campaigns", "creator_id", { status: "published" });
        case "dm_connection":
          return exists(userId, "social_connections", "user_id", { provider, status: "active" });
        case "dm_rule":
          return exists(userId, `${provider}_dm_automations`);
        case "dm_enabled":
          return exists(userId, `${provider}_dm_automations`, "user_id", { enabled: true });
        case "any_dm_rule":
          return dm(false);
        case "any_dm_enabled":
          return dm(true);
        case "mcp_result":
        case "referral_copied":
          return Boolean(progress.data?.first_result_at);
        default:
          return false;
      }
    }
    const keys = [...new Set(app.steps.map((item) => item.proof))];
    const alreadyComplete = Boolean(progress.data?.completed_at);
    const results =
      allowed && !alreadyComplete
        ? await Promise.all(keys.map(async (key) => [key, await proof(key)] as const))
        : [];
    const readiness = Object.fromEntries(results);
    const complete =
      alreadyComplete || (allowed && app.steps.every((item) => readiness[item.proof]));
    if (complete && !progress.data?.completed_at) {
      const { error } = await db
        .from("app_onboarding_progress")
        .upsert(
          { workspace_id: userId, app_id: app.id, completed_at: new Date().toISOString() },
          { onConflict: "workspace_id,app_id" },
        );
      if (error) throw new Error("Your setup progress could not be saved.");
    }
    return {
      allowed,
      readiness,
      complete,
      dismissed: Boolean(progress.data?.dismissed_at),
      showInitially:
        session.data?.status === "applied" && !progress.data?.dismissed_at && !complete,
      context: {
        name: profile.data.display_name as string,
        audience: String(session.data?.brief?.audience ?? ""),
        goal: String(session.data?.brief?.goal ?? ""),
        timezone: profile.data.account_timezone as string | null,
      },
    };
  });
export const setAppGuideDismissed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => appInput.extend({ dismissed: z.boolean() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await db.from("app_onboarding_progress").upsert(
      {
        workspace_id: context.userId,
        app_id: data.appId,
        dismissed_at: data.dismissed ? new Date().toISOString() : null,
      },
      { onConflict: "workspace_id,app_id" },
    );
    if (error) throw new Error("Your guide preference could not be saved.");
    return { ok: true };
  });
export async function recordAppFirstResult(workspaceId: string, appId: "mcp" | "earn") {
  const { error } = await db
    .from("app_onboarding_progress")
    .upsert(
      { workspace_id: workspaceId, app_id: appId, first_result_at: new Date().toISOString() },
      { onConflict: "workspace_id,app_id" },
    );
  if (error) throw new Error("Your first result could not be recorded.");
}
export const recordCopiedReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => recordAppFirstResult(context.userId, "earn"));
