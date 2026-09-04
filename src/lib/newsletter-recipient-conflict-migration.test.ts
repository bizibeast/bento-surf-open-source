import { describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/20260903075808_fix_audience_campaign_recipient_conflict.sql?raw";

describe("newsletter recipient conflict migration", () => {
  it("uses the named unique constraint so output-column names cannot collide", () => {
    expect(migration).toContain(
      "on conflict on constraint audience_campaign_recipients_unique do nothing",
    );
    expect(migration).toContain("prepare_audience_campaign_recipients");
    expect(migration).toContain(
      "revoke all on function public.prepare_audience_campaign_recipients(uuid)",
    );
  });
});
