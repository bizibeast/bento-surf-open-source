import { describe, it, expect } from "vitest";
import {
  productWebsite,
  productWebsiteSchema,
  downloadBenefit,
  productAccentTextColor,
} from "./product-website";
import { sanitizeCommerceSettingsForPublic } from "./commerce";
describe("standalone product websites", () => {
  it("preserves ordered public sections without exposing private downloads", () => {
    const website = productWebsite({
      brand: "Studio",
      accent: "#224466",
      sections: [
        { id: "b", title: "Why it works", body: "Our approach", imageUrl: "" },
        { id: "a", title: "Questions", body: "Answers", imageUrl: "" },
      ],
    });
    const result = sanitizeCommerceSettingsForPublic("digital_product", {
      website,
      files: [{ name: "secret.pdf", url: "https://example.com/private.pdf" }],
    });
    expect(result.website).toEqual(website);
    expect(JSON.stringify(result)).not.toContain("private.pdf");
  });
  it("validates website settings and keeps raw file names out of benefits", () => {
    expect(productWebsiteSchema.safeParse({ accent: "url(javascript:alert(1))" }).success).toBe(
      false,
    );
    expect(
      productWebsiteSchema.safeParse({
        sections: [{ id: "a", title: "", body: "", imageUrl: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
    expect(downloadBenefit("ChatGPT Image Aug 4, 2026.png", 0)).toBe("Image download 1");
  });
});

it("uses readable text for light and dark brand colors", () => {
  expect(productAccentTextColor("#ffffff")).toBe("#000000");
  expect(productAccentTextColor("#eeb637")).toBe("#000000");
  expect(productAccentTextColor("#3478f6")).toBe("#ffffff");
  expect(productAccentTextColor("#27665c")).toBe("#ffffff");
});
