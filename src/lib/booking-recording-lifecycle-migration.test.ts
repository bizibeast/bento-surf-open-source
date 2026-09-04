import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260730020000_atomic_booking_recording_notifications.sql",
  ),
  "utf8",
);

describe("atomic booking recording lifecycle migration", () => {
  it("queues the recording email and publishes its URL together", () => {
    expect(migration).toContain("queue_booking_recording_ready");
    expect(migration).toContain("for update");
    expect(migration).toContain("insert into public.email_outbox");
    expect(migration).toContain("'booking_recording_ready'");
    expect(migration).toContain("recording_status = 'ready'");
    expect(migration).toContain("recording_share_url = v_recording_url");
  });

  it("validates secure recording URLs and repairs legacy missing emails", () => {
    expect(migration).toContain("A valid secure recording URL is required.");
    expect(migration).toContain("Repair legacy ready recordings");
    expect(migration).toContain("on conflict (event_key) do nothing");
  });

  it("keeps the privileged transition private to the service role", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
  });
});
