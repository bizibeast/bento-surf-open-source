import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dodo } from "@/integrations/dodo/client.server";
import { deleteCloudflareHostname } from "./cloudflare-custom-hostnames.server";
import { getMediaBucket } from "./r2-storage.server";
import { enforceRequestRateLimit, RequestHttpError } from "./request-security.server";

const deleteAccountSchema = z.object({ confirmation: z.literal("DELETE") });
const RECENT_AUTH_SECONDS = 10 * 60;

export function hasRecentAuthenticationMethod(
  authenticationMethods: unknown,
  now = Math.floor(Date.now() / 1_000),
) {
  return (
    Array.isArray(authenticationMethods) &&
    authenticationMethods.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const method = (entry as { method?: unknown }).method;
      const timestamp = (entry as { timestamp?: unknown }).timestamp;
      return (
        typeof method === "string" &&
        method !== "anonymous" &&
        method !== "token_refresh" &&
        typeof timestamp === "number" &&
        Number.isFinite(timestamp) &&
        timestamp <= now + 60 &&
        now - timestamp <= RECENT_AUTH_SECONDS
      );
    })
  );
}

export async function deleteR2Prefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1_000, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deleteUserMedia(userId: string) {
  const bucket = getMediaBucket();
  await Promise.all(
    [`avatars/${userId}`, `users/${userId}/`, `private/users/${userId}/`, `og/v2/${userId}/`].map(
      (prefix) => deleteR2Prefix(bucket, prefix),
    ),
  );
}

/** Permanently removes the signed-in account after external services are detached. */
export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => deleteAccountSchema.parse(input))
  .handler(async ({ context }) => {
    if (!hasRecentAuthenticationMethod(context.claims.amr)) {
      throw new RequestHttpError(403, "Sign out and sign in again before deleting your account");
    }
    await enforceRequestRateLimit("EXPENSIVE_API_RATE_LIMITER", "account-delete", context.userId);

    const [{ data: subscription }, { data: domain }] = await Promise.all([
      supabaseAdmin
        .from("subscriptions")
        .select("dodo_subscription_id, status")
        .eq("user_id", context.userId)
        .maybeSingle(),
      supabaseAdmin
        .from("custom_domains")
        .select("cloudflare_hostname_id")
        .eq("user_id", context.userId)
        .maybeSingle(),
    ]);

    if (
      subscription?.dodo_subscription_id &&
      subscription.status &&
      ["active", "trialing", "past_due"].includes(subscription.status)
    ) {
      await dodo.subscriptions.update(subscription.dodo_subscription_id, {
        cancel_at_next_billing_date: true,
      });
    }

    if (domain?.cloudflare_hostname_id) {
      await deleteCloudflareHostname(domain.cloudflare_hostname_id);
    }

    // Delete private blobs before the auth row cascades away so no user-owned files are orphaned.
    await deleteUserMedia(context.userId);

    // Revoke refresh-token sessions globally, then hard-delete the auth user. Existing short-lived
    // access JWTs may remain valid until expiry, but their user row and RLS-owned data are gone.
    const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(
      context.accessToken,
      "global",
    );
    if (signOutError) throw new Error("Your sessions could not be revoked. Please try again.");

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(context.userId);
    if (deleteError) throw new Error("Your account could not be deleted. Please try again.");

    return { deleted: true };
  });
