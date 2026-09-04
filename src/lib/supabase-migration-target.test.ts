import { describe, expect, it } from "vitest";
import { verifySupabaseDatabaseUrl } from "../../scripts/supabase-migration-target";

const projectRef = ["abcdefghij", "klmnopqrst"].join("");
const otherProjectRef = ["zyxwvutsrq", "ponmlkjihg"].join("");
const confirmation = `MIGRATE:${projectRef}`;

describe("Supabase migration target guard", () => {
  it("accepts a deployer-configured direct database URL with matching confirmation", () => {
    expect(
      verifySupabaseDatabaseUrl(
        projectRef,
        `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`,
        confirmation,
      ),
    ).toEqual({ hostname: `db.${projectRef}.supabase.co` });
  });

  it("accepts a matching Supavisor pooler URL", () => {
    expect(
      verifySupabaseDatabaseUrl(
        projectRef,
        `postgresql://postgres.${projectRef}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
        confirmation,
      ),
    ).toEqual({ hostname: "aws-0-us-east-1.pooler.supabase.com" });
  });

  it("rejects a matching pooler username on an unrelated host", () => {
    expect(() =>
      verifySupabaseDatabaseUrl(
        projectRef,
        `postgresql://postgres.${projectRef}:secret@database.example.com:6543/postgres`,
        confirmation,
      ),
    ).toThrow("Database target mismatch");
  });

  it("rejects a database URL for a different project without echoing either reference", () => {
    let message = "";
    try {
      verifySupabaseDatabaseUrl(
        projectRef,
        `postgresql://postgres:secret@db.${otherProjectRef}.supabase.co:5432/postgres`,
        confirmation,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Database target mismatch");
    expect(message).not.toContain(projectRef);
    expect(message).not.toContain(otherProjectRef);
  });

  it("requires confirmation derived from the configured project reference", () => {
    expect(() =>
      verifySupabaseDatabaseUrl(
        projectRef,
        `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`,
        "MIGRATE:different-project",
      ),
    ).toThrow("MIGRATION_CONFIRMATION=MIGRATE:<SUPABASE_PROJECT_ID>");
  });

  it("rejects malformed project references and database URLs", () => {
    expect(() =>
      verifySupabaseDatabaseUrl(
        "not-a-project-ref",
        "postgresql://postgres:secret@localhost/postgres",
        "MIGRATE:not-a-project-ref",
      ),
    ).toThrow("SUPABASE_PROJECT_ID");
    expect(() =>
      verifySupabaseDatabaseUrl(projectRef, "https://example.com", confirmation),
    ).toThrow("postgres or postgresql");
  });
});
