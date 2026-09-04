import { verifySupabaseDatabaseUrl } from "./supabase-migration-target";

const projectRef = process.env.SUPABASE_PROJECT_ID;
if (!projectRef) throw new Error("SUPABASE_PROJECT_ID is required.");

const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) {
  throw new Error("SUPABASE_DB_URL is required. Linked-project migrations are forbidden.");
}

verifySupabaseDatabaseUrl(projectRef, databaseUrl);
const args = ["bunx", "supabase", "db", "push", "--db-url", databaseUrl];
if (process.argv.includes("--dry-run")) args.push("--dry-run");
else args.push("--yes");

console.log("Verified explicit Supabase database target.");
const child = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
