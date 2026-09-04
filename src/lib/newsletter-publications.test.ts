import { describe, expect, it } from "vitest";
import { resolveSelectedPublicationId, uniquePublicationSlug } from "./newsletter-publications";

describe("newsletter publication helpers", () => {
  it("selects the requested publication when it belongs to the loaded set", () => {
    expect(
      resolveSelectedPublicationId(
        [
          { id: "a", isDefault: true },
          { id: "b", isDefault: false },
        ],
        "b",
      ),
    ).toBe("b");
  });

  it("falls back to the default publication", () => {
    expect(resolveSelectedPublicationId([{ id: "a", isDefault: true }], undefined)).toBe("a");
  });

  it("falls back to the first publication when the request is invalid", () => {
    expect(resolveSelectedPublicationId([{ id: "a", isDefault: false }], "missing")).toBe("a");
  });

  it("returns null when there are no publications", () => {
    expect(resolveSelectedPublicationId([], "missing")).toBeNull();
  });

  it("adds the first available numeric suffix to a duplicate slug", () => {
    expect(uniquePublicationSlug("Tech & Trends", ["tech-trends"])).toBe("tech-trends-2");
    expect(uniquePublicationSlug("Tech & Trends", ["tech-trends", "tech-trends-2"])).toBe(
      "tech-trends-3",
    );
  });

  it("keeps generated slugs within the database limit", () => {
    const title = "a".repeat(120);
    const base = "a".repeat(96);

    expect(uniquePublicationSlug(title, [])).toBe(base);
    expect(uniquePublicationSlug(title, [base])).toBe(`${"a".repeat(94)}-2`);
  });
});
