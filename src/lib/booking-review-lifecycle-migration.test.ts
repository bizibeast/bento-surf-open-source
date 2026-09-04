import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260730010000_atomic_booking_review_requests.sql"),
  "utf8",
);

describe("atomic booking review lifecycle migration", () => {
  it("queues the private review token, outbox email, and completion together", () => {
    expect(migration).toContain("queue_booking_review_request");
    expect(migration).toContain("for update");
    expect(migration).toContain("insert into public.booking_reviews");
    expect(migration).toContain("insert into public.email_outbox");
    expect(migration).toContain("'booking_review_request'");
    expect(migration).toContain("status = 'completed'");
  });

  it("heals incomplete legacy attempts without replacing submitted reviews", () => {
    expect(migration).toContain("where event_key = v_event_key");
    expect(migration).toContain("and submitted_at is null");
    expect(migration).toContain("Never replace a review that the customer already submitted");
  });

  it("keeps the privileged transition private to the service role", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });
});
