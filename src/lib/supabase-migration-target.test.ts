import { afterEach, describe, expect, it } from "vitest";
import {
  SUPABASE_PROJECTS,
  verifySupabaseDatabaseUrl,
} from "../../scripts/supabase-migration-target";

const originalConfirmation = process.env.MIGRATION_CONFIRMATION;

afterEach(() => {
  if (originalConfirmation === undefined) delete process.env.MIGRATION_CONFIRMATION;
  else process.env.MIGRATION_CONFIRMATION = originalConfirmation;
});

describe("Supabase migration target guard", () => {
  it("accepts an explicitly confirmed direct staging database URL", () => {
    process.env.MIGRATION_CONFIRMATION = `STAGING:${SUPABASE_PROJECTS.staging}`;

    expect(
      verifySupabaseDatabaseUrl(
        "staging",
        `postgresql://postgres:secret@db.${SUPABASE_PROJECTS.staging}.supabase.co:5432/postgres`,
      ),
    ).toMatchObject({ expectedProject: SUPABASE_PROJECTS.staging });
  });

  it("accepts a confirmed Supavisor pooler URL", () => {
    process.env.MIGRATION_CONFIRMATION = `PRODUCTION:${SUPABASE_PROJECTS.production}`;

    expect(
      verifySupabaseDatabaseUrl(
        "production",
        `postgresql://postgres.${SUPABASE_PROJECTS.production}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      ),
    ).toMatchObject({ expectedProject: SUPABASE_PROJECTS.production });
  });

  it("rejects a production URL when staging was requested", () => {
    process.env.MIGRATION_CONFIRMATION = `STAGING:${SUPABASE_PROJECTS.staging}`;

    expect(() =>
      verifySupabaseDatabaseUrl(
        "staging",
        `postgresql://postgres:secret@db.${SUPABASE_PROJECTS.production}.supabase.co:5432/postgres`,
      ),
    ).toThrow("Database target mismatch");
  });

  it("rejects an unconfirmed target", () => {
    delete process.env.MIGRATION_CONFIRMATION;

    expect(() =>
      verifySupabaseDatabaseUrl(
        "staging",
        `postgresql://postgres:secret@db.${SUPABASE_PROJECTS.staging}.supabase.co:5432/postgres`,
      ),
    ).toThrow("MIGRATION_CONFIRMATION");
  });
});
