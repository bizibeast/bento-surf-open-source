import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import template from "./self-hosted-template.txt?raw";
import { buildSetupEnv, parseSetupFields, validateSetup } from "./self-hosted-setup";

const values = {
  VITE_APP_URL: "http://localhost:8080",
  VITE_PUBLIC_URL: "http://localhost:8080",
  SUPABASE_PROJECT_ID: "my-project",
  SUPABASE_URL: "https://my-project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  SUPABASE_DB_URL: "postgresql://user:pass@db.example:5432/postgres",
  WORKSPACE_COOKIE_SIGNING_KEY: "a".repeat(64),
};

describe("self-hosted setup", () => {
  it("keeps the browser template aligned with the operator template", () => {
    expect(template).toBe(readFileSync(".env.example", "utf8"));
  });

  it("covers every configurable template field without exposing generated duplicates", () => {
    const names = new Set(parseSetupFields(template).map((field) => field.name));
    const templateNames = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    expect(names.size).toBe(templateNames.length - 6);
    expect(names.has("SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(names.has("OPENROUTER_API_KEY")).toBe(true);
    expect(names.has("VITE_SUPABASE_PUBLISHABLE_KEY")).toBe(false);
  });

  it("generates aligned public settings and a guarded migration target", () => {
    expect(validateSetup(values)).toEqual([]);
    const result = buildSetupEnv(template, {
      ...values,
      RESEND_API_KEY: "a key with spaces # and $",
    });
    expect(result).toContain("VITE_SUPABASE_URL=https://my-project.supabase.co");
    expect(result).toContain("VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test");
    expect(result).toContain("MIGRATION_CONFIRMATION=MIGRATE:my-project");
    expect(result).toContain("EMAIL_DELIVERY_MODE=disabled");
    expect(result).toContain('RESEND_API_KEY="a key with spaces # and $"');
    expect(result).not.toContain("VITE_SUPABASE_PUBLISHABLE_KEY=service-secret");
  });

  it("requires migration, sign-in, and cookie settings before export", () => {
    expect(
      validateSetup({
        ...values,
        SUPABASE_SERVICE_ROLE_KEY: "",
        WORKSPACE_COOKIE_SIGNING_KEY: "short",
      }),
    ).toEqual(
      expect.arrayContaining([
        "SUPABASE_SERVICE_ROLE_KEY is required.",
        "WORKSPACE_COOKIE_SIGNING_KEY must be at least 32 bytes.",
      ]),
    );
  });

  it("rejects a Supabase project mismatch before suggesting migrations", () => {
    expect(validateSetup({ ...values, SUPABASE_PROJECT_ID: "another-project" })).toContain(
      "SUPABASE_PROJECT_ID must match the project in SUPABASE_URL.",
    );
  });
});
