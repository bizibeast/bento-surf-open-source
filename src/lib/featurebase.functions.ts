import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createFeaturebaseJwt, resolveFeaturebaseName } from "@/lib/featurebase.server";

export const getFeaturebaseIdentity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const secret = process.env.FEATUREBASE_JWT_SECRET?.trim();
    if (!secret) return { featurebaseJwt: null, identified: false as const };

    const claims = context.claims as Record<string, unknown>;
    let email = typeof claims.email === "string" ? claims.email.trim() : "";
    if (!email) {
      const { data, error } = await context.supabase.auth.getUser();
      if (error) throw new Error(error.message);
      email = data.user?.email?.trim() ?? "";
    }
    if (!email) return { featurebaseJwt: null, identified: false as const };

    const userMetadata =
      claims.user_metadata && typeof claims.user_metadata === "object"
        ? (claims.user_metadata as Record<string, unknown>)
        : {};
    const { data: profile } = await context.supabase
      .from("profiles")
      .select("username, display_name")
      .eq("id", context.userId)
      .maybeSingle();
    const name = resolveFeaturebaseName({
      username: profile?.username,
      displayName: profile?.display_name,
      metadataFullName: userMetadata.full_name,
      metadataName: userMetadata.name,
      email,
    });

    return {
      featurebaseJwt: await createFeaturebaseJwt(
        {
          userId: context.userId,
          email,
          name,
        },
        secret,
      ),
      identified: true as const,
    };
  });
