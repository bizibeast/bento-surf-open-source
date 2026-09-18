import {
  SUPABASE_PROJECTS,
  verifySupabaseDatabaseUrl,
  type SupabaseTarget,
} from "./supabase-migration-target";

const target = process.argv[2] as SupabaseTarget | undefined;
if (!target || !(target in SUPABASE_PROJECTS)) {
  throw new Error("Usage: bun scripts/migrate-supabase.ts <staging|production> [--dry-run]");
}

const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) {
  throw new Error("SUPABASE_DB_URL is required. Linked-project migrations are forbidden.");
}

const verified = verifySupabaseDatabaseUrl(target, databaseUrl);
const args = ["bunx", "supabase", "db", "push", "--db-url", databaseUrl];
if (process.argv.includes("--dry-run")) args.push("--dry-run");
else args.push("--yes");

console.log(`Verified explicit ${target} database target ${verified.expectedProject}.`);
const child = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
