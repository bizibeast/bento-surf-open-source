export function verifySupabaseDatabaseUrl(
  projectId: string,
  rawUrl: string,
  confirmation: string | undefined,
) {
  if (!/^[a-z0-9-]+$/.test(projectId)) {
    throw new Error("SUPABASE_PROJECT_ID must be a valid Supabase project reference.");
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
  const directHostMatches = hostname === `db.${projectId}.supabase.co`;
  const poolerMatches =
    /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname) && username === `postgres.${projectId}`;

  if (!directHostMatches && !poolerMatches) {
    throw new Error(
      "Database target mismatch: SUPABASE_DB_URL does not identify SUPABASE_PROJECT_ID.",
    );
  }

  if (confirmation !== `MIGRATE:${projectId}`) {
    throw new Error(
      "Set MIGRATION_CONFIRMATION=MIGRATE:<SUPABASE_PROJECT_ID> to authorize this migration.",
    );
  }

  return { expectedProject: projectId, hostname };
}
