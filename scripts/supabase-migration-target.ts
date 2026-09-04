export function verifySupabaseDatabaseUrl(
  projectRef: string,
  rawUrl: string,
  confirmation = process.env.MIGRATION_CONFIRMATION,
) {
  const expectedProject = projectRef.trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(expectedProject)) {
    throw new Error("SUPABASE_PROJECT_ID must be a valid 20-character project reference.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SUPABASE_DB_URL must be a valid percent-encoded Postgres URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("SUPABASE_DB_URL must use the postgres or postgresql protocol.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const directHostMatches = hostname === `db.${expectedProject}.supabase.co`;
  const poolerUserMatches =
    hostname.endsWith(".pooler.supabase.com") && username === `postgres.${expectedProject}`;

  if (!directHostMatches && !poolerUserMatches) {
    throw new Error("Database target mismatch: the URL identifies a different Supabase project.");
  }

  if (confirmation !== `MIGRATE:${expectedProject}`) {
    throw new Error(
      "Set MIGRATION_CONFIRMATION=MIGRATE:<SUPABASE_PROJECT_ID> to authorize this migration.",
    );
  }

  return { hostname };
}
