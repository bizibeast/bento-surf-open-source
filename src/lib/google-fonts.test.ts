import { describe, expect, it } from "vitest";
import { googleFontHref } from "./google-fonts";

describe("googleFontHref", () => {
  it("loads a family without assuming unsupported weights", () => {
    expect(googleFontHref("Abril Fatface")).toBe(
      "https://fonts.googleapis.com/css2?family=Abril+Fatface&display=swap",
    );
    expect(googleFontHref("Abril Fatface")).not.toContain(":wght@");
  });

  it("normalizes whitespace in family names", () => {
    expect(googleFontHref("  Plus   Jakarta Sans  ")).toBe(
      "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans&display=swap",
    );
  });
});
