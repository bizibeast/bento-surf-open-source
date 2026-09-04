import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260730003000_booking_reminder_lifecycle.sql",
);

describe("booking reminder lifecycle migration", () => {
  it("persists both reminder stages and indexes only actionable calls", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("reminder_24h_sent_at timestamptz");
    expect(sql).toContain("reminder_1h_sent_at timestamptz");
    expect(sql).toContain("commerce_bookings_reminders_idx");
    expect(sql).toContain("where status = 'confirmed'");
  });
});
