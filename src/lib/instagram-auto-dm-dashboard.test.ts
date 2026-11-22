import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Instagram Auto-DM activity", () => {
  it("keeps safety skips visible while filtering unrelated ignored events", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/instagram-auto-dm.functions.ts"),
      "utf8",
    );
    const query = source.slice(
      source.indexOf('.from("instagram_dm_events")'),
      source.indexOf(
        ": Promise.resolve({ data: [], error: null })",
        source.indexOf('.from("instagram_dm_events")'),
      ),
    );

    expect(query).toContain(
      "error_code.in.(recipient_preference_updated,recipient_opted_out,recipient_cooldown,account_budget,account_paused,recipient_missing)",
    );
    expect(query.indexOf(".or(")).toBeLessThan(query.indexOf(".limit(50)"));
  });
});
