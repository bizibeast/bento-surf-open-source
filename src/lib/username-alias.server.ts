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
  const [profileResult, aliasResult] = await Promise.all([
    db.from("profiles").select("id,username").eq("username", username).maybeSingle(),
    db
      .from("profile_username_aliases")
      .select("user_id")
      .eq("username", username)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(),
  ]);
  if (profileResult.error) throw new Error(profileResult.error.message);
  if (profileResult.data) {
    return {
      userId: profileResult.data.id,
      username: profileResult.data.username,
      isAlias: false,
    };
  }

  const alias = aliasResult.data;
  if (aliasResult.error) throw new Error(aliasResult.error.message);
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
