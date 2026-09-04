/* eslint-disable @typescript-eslint/no-explicit-any -- Shared by typed and service-role Supabase clients. */

export type ResolvedPublicUsername = {
  userId: string;
  username: string;
  isAlias: boolean;
};

export async function resolvePublicUsername(
  db: any,
  requestedUsername: string,
): Promise<ResolvedPublicUsername | null> {
  const username = requestedUsername.replace(/^@/, "").trim().toLowerCase();
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("id,username")
    .eq("username", username)
    .maybeSingle();
  if (profileError) throw new Error(profileError.message);
  if (profile) return { userId: profile.id, username: profile.username, isAlias: false };

  const { data: alias, error: aliasError } = await db
    .from("profile_username_aliases")
    .select("user_id")
    .eq("username", username)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (aliasError) throw new Error(aliasError.message);
  if (!alias) return null;

  const { data: currentProfile, error: currentProfileError } = await db
    .from("profiles")
    .select("id,username")
    .eq("id", alias.user_id)
    .maybeSingle();
  if (currentProfileError) throw new Error(currentProfileError.message);
  if (!currentProfile) return null;
  return {
    userId: currentProfile.id,
    username: currentProfile.username,
    isAlias: true,
  };
}
