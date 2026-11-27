import { describe, expect, it } from "vitest";
import { resolvePublicCreatorTheme } from "./public-creator-theme";

describe("creator theme on product pages", () => {
  it("uses the Link palette and light background rather than product website defaults", () => {
    const theme = resolvePublicCreatorTheme({ theme: "light", accent_color: "blue" });
    expect(theme.mode).toBe("light");
    expect(theme.accentHex).toBe("#3b82f6");
    expect(theme.style["--background"]).toBe("color-mix(in oklab, #3b82f6 8%, #ffffff)");
    expect(theme.style["--card"]).toBe("color-mix(in oklab, #3b82f6 4%, #ffffff)");
    expect(theme.style["--border"]).toBe("color-mix(in oklab, #3b82f6 20%, #ffffff)");
    expect(theme.style["--product-accent"]).toBe("#3b82f6");
  });

  it("carries the Link dark background, pattern settings and creator typography", () => {
    const theme = resolvePublicCreatorTheme({
      theme: "dark",
      accent_color: "#a855f7",
      pattern: "custom_photo",
      pattern_settings: { image_url: "https://example.test/backdrop.jpg", opacity: 85 },
      primary_font: "Plus Jakarta Sans",
      secondary_font: "Abril Fatface",
    });
    expect(theme.style["--background"]).toBe("color-mix(in oklab, #a855f7 14%, #0b0b14)");
    expect(theme.style["--card"]).toBe("color-mix(in oklab, #a855f7 10%, #11111b)");
    expect(theme.pattern).toBe("custom_photo");
    expect(theme.patternSettings).toMatchObject({
      opacity: 85,
      blur: 0,
      image_url: "https://example.test/backdrop.jpg",
    });
    expect(theme.style["--font-sans"]).toContain('"Plus Jakarta Sans"');
    expect(theme.style["--font-display"]).toContain('"Abril Fatface"');
    expect(theme.style.colorScheme).toBe("dark");
  });

  it("preserves ordinary Link text colors and makes pale custom accents readable", () => {
    expect(resolvePublicCreatorTheme({ accent_color: "indigo" }).style["--foreground"]).toBe(
      "color-mix(in oklab, #6366f1 75%, #000000)",
    );
    const pale = resolvePublicCreatorTheme({ theme: "light", accent_color: "#ffffff" });
    expect(pale.style["--foreground"]).toBe("#000000");
    expect(pale.style["--accent-foreground"]).toBe("#000000");
    expect(pale.style["--product-on-accent"]).toBe("#000000");
    const dark = resolvePublicCreatorTheme({ theme: "dark", accent_color: "#000000" });
    expect(dark.style["--accent-foreground"]).toBe("#ffffff");
    expect(dark.style["--product-on-accent"]).toBe("#ffffff");
    // White text on orange is below 4.5:1. Black text is above 8:1.
    expect(resolvePublicCreatorTheme({ accent_color: "orange" }).style["--product-on-accent"]).toBe(
      "#000000",
    );
  });

  it("ignores malformed theme values and unapproved fonts", () => {
    const theme = resolvePublicCreatorTheme({
      theme: "unexpected",
      accent_color: "red; background:url(bad)",
      pattern: "__proto__",
      pattern_settings: ["unexpected"],
      primary_font: 'Custom"; color: red',
      secondary_font: "unknown",
    });
    expect(theme.mode).toBe("light");
    expect(theme.accentHex).toBe("#6366f1");
    expect(theme.pattern).toBe("none");
    expect(theme.style["--font-sans"]).toContain('"Inter"');
    expect(theme.style["--font-display"]).toContain('"Instrument Serif"');
    expect(theme.patternSettings).toMatchObject({ opacity: 70, intensity: 60 });
  });
});
