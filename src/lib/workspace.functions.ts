import { createServerFn } from "@tanstack/react-start";
import { setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RequestHttpError } from "./request-security.server";
import {
  resolveWorkspace,
  signWorkspaceCookie,
  WORKSPACE_COOKIE,
  workspaceCookieSigningKey,
} from "./workspace-session.server";

export const getWorkspaceSession = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => context.workspaceSession);

export const switchWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ workspaceId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const session = await resolveWorkspace(context.authUserId, data.workspaceId);
    if (session.workspaceId !== data.workspaceId) {
      throw new RequestHttpError(403, "Workspace is unavailable.");
    }
    const signed = await signWorkspaceCookie(data.workspaceId, workspaceCookieSigningKey());
    setCookie(WORKSPACE_COOKIE, signed, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
    return session;
  });

export const updateAccountPreference = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ appTheme: z.enum(["light", "dark"]) }).parse(input))
  .handler(async ({ context, data }) => {
    // New table is deployed before generated Supabase types are refreshed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any;
    const { data: preference, error } = await db
      .from("account_preferences")
      .update({ app_theme: data.appTheme })
      .eq("auth_user_id", context.authUserId)
      .select("app_theme")
      .single();
    if (error) throw new Error("Theme preference could not be saved.");
    return { appTheme: preference.app_theme as "light" | "dark" };
  });
