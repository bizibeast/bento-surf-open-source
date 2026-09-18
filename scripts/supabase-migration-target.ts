export const SUPABASE_PROJECTS = {
  staging: "pjraekywkqilhaqrxzpe",
  production: "qefsatsrhpmgoahutkqu",
} as const;

export type SupabaseTarget = keyof typeof SUPABASE_PROJECTS;

export function verifySupabaseDatabaseUrl(target: SupabaseTarget, rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SUPABASE_DB_URL must be a valid percent-encoded Postgres URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("SUPABASE_DB_URL must use the postgres or postgresql protocol.");
  }

  const expectedProject = SUPABASE_PROJECTS[target];
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username).toLowerCase();
  const directHostMatches = hostname === `db.${expectedProject}.supabase.co`;
  const poolerUserMatches = username === `postgres.${expectedProject}`;

  if (!directHostMatches && !poolerUserMatches) {
    throw new Error(
      `Database target mismatch: expected the ${target} Supabase project ${expectedProject}, but the URL identifies a different project.`,
    );
  }

  const expectedConfirmation = `${target.toUpperCase()}:${expectedProject}`;
  if (process.env.MIGRATION_CONFIRMATION !== expectedConfirmation) {
    throw new Error(
      `Set MIGRATION_CONFIRMATION=${expectedConfirmation} to authorize this migration.`,
    );
  }

  return { expectedProject, hostname };
}
