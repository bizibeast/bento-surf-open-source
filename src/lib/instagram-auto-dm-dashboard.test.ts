import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Instagram Auto-DM activity", () => {
  it("filters ignored webhook events before limiting recent activity", () => {
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

    expect(query).toContain('.neq("status", "ignored")');
    expect(query.indexOf('.neq("status", "ignored")')).toBeLessThan(query.indexOf(".limit(50)"));
  });
});
