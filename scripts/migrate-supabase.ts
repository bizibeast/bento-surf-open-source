import { verifySupabaseDatabaseUrl } from "./supabase-migration-target";

if (process.argv.slice(2).some((arg) => arg !== "--dry-run")) {
  throw new Error("Usage: bun scripts/migrate-supabase.ts [--dry-run]");
}

const projectId = process.env.SUPABASE_PROJECT_ID;
if (!projectId) throw new Error("SUPABASE_PROJECT_ID is required.");
const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) {
  throw new Error("SUPABASE_DB_URL is required. Linked-project migrations are forbidden.");
}

const verified = verifySupabaseDatabaseUrl(
  projectId,
  databaseUrl,
  process.env.MIGRATION_CONFIRMATION,
);
const args = ["bunx", "supabase", "db", "push", "--db-url", databaseUrl];
if (process.argv.includes("--dry-run")) args.push("--dry-run");
else args.push("--yes");

console.log(`Verified explicit Supabase database target ${verified.expectedProject}.`);
const child = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
