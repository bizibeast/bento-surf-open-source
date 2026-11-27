import { describe, expect, it } from "vitest";
import { isCommerceProductListed } from "./commerce-visibility";

describe("public session discovery", () => {
  it.each([undefined, null, {}, { calendarVisibility: "listed" }])(
    "keeps existing sessions listed by default (%j)",
    (settings) => {
      expect(isCommerceProductListed({ kind: "coaching_call", settings })).toBe(true);
    },
  );
  it("hides only explicitly unlisted coaching sessions from discovery", () => {
    expect(
      isCommerceProductListed({
        kind: "coaching_call",
        settings: { calendarVisibility: "unlisted" },
      }),
    ).toBe(false);
    expect(
      isCommerceProductListed({ kind: "course", settings: { calendarVisibility: "unlisted" } }),
    ).toBe(true);
  });
});
