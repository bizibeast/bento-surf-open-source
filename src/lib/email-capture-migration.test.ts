import sql from "../../supabase/migrations/20260831034352_functional_email_capture.sql?raw";
import { describe, expect, it } from "vitest";

describe("functional email capture migration", () => {
  it("keeps public captures atomic and service-role only", () => {
    expect(sql).toContain("create or replace function public.capture_public_email_audience");
    expect(sql).toContain("public.commerce_upsert_audience_contact");
    expect(sql).toContain("'email_captured'");
    expect(sql).toContain("public.audience_consent_events");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toMatch(/from public\.blocks[\s\S]*type = 'email_capture'[\s\S]*for update/);
    expect(sql).toContain("email-capture:");
    expect(sql).toContain("'disclosure', 'creator_updates'");
    expect(sql).toContain(
      "grant execute on function public.capture_public_email_audience(uuid, text) to service_role",
    );
    expect(sql).toContain(
      "revoke all on function public.capture_public_email_audience(uuid, text) from public, anon, authenticated",
    );
  });
});
