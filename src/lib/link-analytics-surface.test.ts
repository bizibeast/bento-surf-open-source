import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Link analytics surface", () => {
  it("opens analytics from the editor dock instead of Settings", async () => {
    const [dashboard, settings] = await Promise.all([
      readFile(resolve(process.cwd(), "src/routes/_authenticated/link.tsx"), "utf8"),
      readFile(resolve(process.cwd(), "src/routes/_authenticated/settings.tsx"), "utf8"),
    ]);

    expect(dashboard).toContain('aria-label="Analytics"');
    expect(dashboard).toContain("<AnalyticsSettingsPanel plan={creatorPlan} />");
    expect(dashboard.indexOf("<AppearancePopover")).toBeLessThan(
      dashboard.indexOf('aria-label="Analytics"'),
    );
    expect(dashboard.indexOf('aria-label="Analytics"')).toBeLessThan(
      dashboard.indexOf('aria-label="Laptop view"'),
    );
    expect(settings).not.toContain("AnalyticsSettingsPanel");
    expect(settings).not.toContain('{ id: "analytics", label: "Analytics"');
  });
});
