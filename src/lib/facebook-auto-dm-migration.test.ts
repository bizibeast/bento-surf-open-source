import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260814120000_facebook_auto_dm.sql"),
  "utf8",
).toLowerCase();
const functionsSource = readFileSync(
  resolve(process.cwd(), "src/lib/facebook-auto-dm.functions.ts"),
  "utf8",
);

describe("Facebook Auto-DM durable workflow migrations", () => {
  it("keeps workflow state service-only and sender-bound", () => {
    expect(migration).toContain("alter table public.facebook_dm_runs enable row level security");
    expect(migration).toContain("grant all on public.facebook_dm_runs to service_role");
    expect(migration).toContain(
      "revoke all on public.facebook_dm_runs from public, anon, authenticated",
    );
    expect(migration).toContain("hmac-derived sender binding");
  });

  it("claims events with a single decision row", () => {
    expect(migration).toContain("create or replace function public.claim_facebook_dm_event");
    expect(migration).toContain("return query select claimed_id, false;\n    return;");
  });
});

describe("Facebook Auto-DM activity", () => {
  it("filters ignored webhook events before limiting recent activity", () => {
    const query = functionsSource.slice(
      functionsSource.indexOf('.from("facebook_dm_events")'),
      functionsSource.indexOf(
        ": Promise.resolve({ data: [], error: null })",
        functionsSource.indexOf('.from("facebook_dm_events")'),
      ),
    );
    expect(query).toContain('.neq("status", "ignored")');
    expect(query.indexOf('.neq("status", "ignored")')).toBeLessThan(query.indexOf(".limit(50)"));
  });
});
