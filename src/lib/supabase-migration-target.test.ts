import { describe, expect, it } from "vitest";
import { verifySupabaseDatabaseUrl } from "../../scripts/supabase-migration-target";

const projectId = "myprojectref";
const confirmation = `MIGRATE:${projectId}`;

describe("Supabase migration target guard", () => {
  it("accepts an explicitly confirmed direct database URL for the operator's project", () => {
    expect(
      verifySupabaseDatabaseUrl(
        projectId,
        `postgresql://postgres:secret@db.${projectId}.supabase.co:5432/postgres`,
        confirmation,
      ),
    ).toMatchObject({ expectedProject: projectId });
  });

  it("accepts a confirmed Supavisor pooler URL", () => {
    expect(
      verifySupabaseDatabaseUrl(
        projectId,
        `postgresql://postgres.${projectId}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
        confirmation,
      ),
    ).toMatchObject({ expectedProject: projectId });
  });

  it("rejects another project's database", () => {
    expect(() =>
      verifySupabaseDatabaseUrl(
        projectId,
        "postgresql://postgres:secret@db.otherproject.supabase.co:5432/postgres",
        confirmation,
      ),
    ).toThrow("Database target mismatch");
  });

  it("rejects a pooler identity on an unrelated host", () => {
    expect(() =>
      verifySupabaseDatabaseUrl(
        projectId,
        `postgresql://postgres.${projectId}:secret@database.example.com:6543/postgres`,
        confirmation,
      ),
    ).toThrow("Database target mismatch");
  });

  it("rejects an unconfirmed target", () => {
    expect(() =>
      verifySupabaseDatabaseUrl(
        projectId,
        `postgresql://postgres:secret@db.${projectId}.supabase.co:5432/postgres`,
        undefined,
      ),
    ).toThrow("MIGRATION_CONFIRMATION");
  });
});
