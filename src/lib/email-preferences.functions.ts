/* eslint-disable @typescript-eslint/no-explicit-any -- Email tables are introduced by the lifecycle migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type EmailPreferences = {
  productUpdates: boolean;
  weeklyDigest: boolean;
  marketingUnsubscribed: boolean;
};

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  productUpdates: true,
  weeklyDigest: true,
  marketingUnsubscribed: false,
};

export const getMyEmailPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as any;
    const { data, error } = await db
      .from("email_preferences")
      .select("product_updates, weekly_digest, marketing_unsubscribed_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") {
        return DEFAULT_EMAIL_PREFERENCES;
      }
      throw new Error(error.message);
    }
    if (!data) return DEFAULT_EMAIL_PREFERENCES;
    return {
      productUpdates: Boolean(data.product_updates),
      weeklyDigest: Boolean(data.weekly_digest),
      marketingUnsubscribed: Boolean(data.marketing_unsubscribed_at),
    } satisfies EmailPreferences;
  });

export const updateMyEmailPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        productUpdates: z.boolean(),
        weeklyDigest: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const db = context.supabase as any;
    const optedIn = data.productUpdates || data.weeklyDigest;
    const { error } = await db.from("email_preferences").upsert(
      {
        user_id: context.userId,
        product_updates: data.productUpdates,
        weekly_digest: data.weeklyDigest,
        marketing_unsubscribed_at: optedIn ? null : new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(error.message);
    return {
      productUpdates: data.productUpdates,
      weeklyDigest: data.weeklyDigest,
      marketingUnsubscribed: !optedIn,
    } satisfies EmailPreferences;
  });
