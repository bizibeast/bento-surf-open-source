import { describe, expect, it } from "vitest";
import { landingPageHead, publicPageHead, publicProductHead } from "./open-graph";
import { publicCalendarHead } from "./public-calendar-seo";
import {
  SEO_DESCRIPTION_MAX,
  SEO_DESCRIPTION_MIN,
  seoDocumentTitle,
  seoMetaDescription,
} from "./seo-description";

function descriptionOf(meta: Array<{ name?: string; content?: string }>) {
  return meta.find((item) => item.name === "description")?.content ?? "";
}

describe("seo meta description length", () => {
  it("keeps copy between 70 and 160 characters", () => {
    const short = seoMetaDescription(
      "Read .",
      "Read newsletters from Ari (@ari) on bento.surf. Browse public issues and subscribe from their page.",
    );
    const long = seoMetaDescription(
      "word ".repeat(80),
      "unused fallback that is definitely long enough for the minimum.",
    );
    expect(short.length).toBeGreaterThanOrEqual(SEO_DESCRIPTION_MIN);
    expect(short.length).toBeLessThanOrEqual(SEO_DESCRIPTION_MAX);
    expect(long.length).toBeLessThanOrEqual(SEO_DESCRIPTION_MAX);
    expect(long.endsWith(".")).toBe(true);
  });

  it("drops the blog suffix before a title passes 65 characters", () => {
    expect(seoDocumentTitle("Email marketing for creators")).toBe(
      "Email marketing for creators | bento.surf",
    );
    expect(
      seoDocumentTitle("How to sell digital products on Instagram without a website").length,
    ).toBeLessThanOrEqual(65);
    expect(
      seoDocumentTitle("How to sell digital products on Instagram without a website"),
    ).not.toMatch(/\| bento\.surf$/);
  });

  it("builds profile, calendar, product, and homepage descriptions in range", () => {
    const home = descriptionOf(landingPageHead().meta);
    const profile = descriptionOf(
      publicPageHead({
        profile: {
          id: "1",
          username: "bizibeast",
          display_name: "Bizibeast",
          bio: "",
          meta_description: "",
          updated_at: "2026-10-18T00:00:00.000Z",
        },
        pages: [],
        blocks: [],
        activePageId: null,
      }).meta,
    );
    const calendar = descriptionOf(
      publicCalendarHead({
        profile: { username: "bizibeast", displayName: "Bizibeast", avatarUrl: null },
        pages: [],
        sessions: [],
      }).meta,
    );
    const product = descriptionOf(
      publicProductHead({
        product: {
          slug: "guide",
          public_slug: "guide",
          title: "Guide",
          subtitle: "Short",
          description: null,
          cover_url: null,
        },
        creator: { username: "bizibeast", display_name: "Bizibeast" },
      }).meta,
    );
    for (const value of [home, profile, calendar, product]) {
      expect(value.length).toBeGreaterThanOrEqual(SEO_DESCRIPTION_MIN);
      expect(value.length).toBeLessThanOrEqual(SEO_DESCRIPTION_MAX);
    }
    expect(profile).not.toBe("Find bizibeast on bento.surf.");
    expect(calendar).not.toMatch(/^View .+\.$/);
  });
});
