import type { CSSProperties } from "react";
import { isGoogleFont } from "./google-fonts";
import {
  ACCENT_PALETTE,
  DEFAULT_SETTINGS,
  PATTERN_BY_ID,
  type PatternId,
  type PatternSettings,
} from "./patterns/registry";

export type PublicCreatorThemeInput = {
  theme?: string | null;
  accent_color?: string | null;
  primary_font?: string | null;
  secondary_font?: string | null;
  pattern?: string | null;
  pattern_settings?: unknown;
};

type ThemeStyle = CSSProperties & Record<`--${string}`, string>;

// Evaluate the same Oklab mixes as CSS so custom pale/near-black accents do
// not turn Link-derived text or checkout buttons into unreadable combinations.
function linearRgb(hex: string) {
  return [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
}

function oklab(hex: string) {
  const [r, g, b] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function mixedLuminance(accent: string, percent: number, base: string) {
  const source = oklab(accent);
  const target = oklab(base);
  const [L, a, b] = source.map(
    (value, i) => (value * percent) / 100 + target[i] * (1 - percent / 100),
  );
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((value) => Math.min(1, Math.max(0, value)));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: number, b: number) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Link's creator palette, typography and backdrop, independent of product layout. */
export function resolvePublicCreatorTheme(profile: PublicCreatorThemeInput = {}) {
  const mode: "light" | "dark" = profile.theme === "dark" ? "dark" : "light";
  const accentId = profile.accent_color ?? "indigo";
  const accentHex =
    ACCENT_PALETTE.find((accent) => accent.id === accentId)?.hex ??
    (/^#[0-9a-f]{6}$/i.test(accentId) ? accentId : "#6366f1");
  const mix = (percent: number, base: string) =>
    `color-mix(in oklab, ${accentHex} ${percent}%, ${base})`;
  const style: ThemeStyle =
    mode === "dark"
      ? {
          "--background": mix(14, "#0b0b14"),
          "--foreground": mix(35, "#ffffff"),
          "--card": mix(10, "#11111b"),
          "--muted": mix(18, "#1a1a22"),
          "--muted-foreground": mix(40, "#ffffff"),
          "--accent": mix(28, "#1f1f29"),
          "--accent-foreground": mix(60, "#ffffff"),
          "--primary": accentHex,
          "--primary-foreground": "#ffffff",
          "--ring": accentHex,
          "--border": mix(22, "#1f1f29"),
        }
      : {
          "--background": mix(8, "#ffffff"),
          "--foreground": mix(75, "#000000"),
          "--card": mix(4, "#ffffff"),
          "--muted": mix(14, "#ffffff"),
          "--muted-foreground": mix(55, "#000000"),
          "--accent": mix(18, "#ffffff"),
          "--accent-foreground": mix(70, "#000000"),
          "--primary": accentHex,
          "--primary-foreground": "#ffffff",
          "--ring": accentHex,
          "--border": mix(20, "#ffffff"),
        };
  const surfaceLuminances =
    mode === "dark"
      ? [mixedLuminance(accentHex, 14, "#0b0b14"), mixedLuminance(accentHex, 10, "#11111b")]
      : [mixedLuminance(accentHex, 8, "#ffffff"), mixedLuminance(accentHex, 4, "#ffffff")];
  const fallbackInk = mode === "dark" ? "#ffffff" : "#000000";
  const foregroundLuminance = mixedLuminance(
    accentHex,
    mode === "dark" ? 35 : 75,
    mode === "dark" ? "#ffffff" : "#000000",
  );
  const mutedLuminance = mixedLuminance(
    accentHex,
    mode === "dark" ? 40 : 55,
    mode === "dark" ? "#ffffff" : "#000000",
  );
  if (surfaceLuminances.some((surface) => contrast(foregroundLuminance, surface) < 4.5)) {
    style["--foreground"] = fallbackInk;
  }
  if (surfaceLuminances.some((surface) => contrast(mutedLuminance, surface) < 4.5)) {
    style["--muted-foreground"] = fallbackInk;
  }
  const accentSurfaceLuminance = mixedLuminance(
    accentHex,
    mode === "dark" ? 28 : 18,
    mode === "dark" ? "#1f1f29" : "#ffffff",
  );
  const accentTextLuminance = mixedLuminance(
    accentHex,
    mode === "dark" ? 60 : 70,
    mode === "dark" ? "#ffffff" : "#000000",
  );
  if (contrast(accentTextLuminance, accentSurfaceLuminance) < 4.5) {
    style["--accent-foreground"] = fallbackInk;
  }
  const accentLuminance = mixedLuminance(accentHex, 100, "#ffffff");
  style["--primary-foreground"] =
    contrast(accentLuminance, 0) >= contrast(accentLuminance, 1) ? "#000000" : "#ffffff";
  const bodyFont =
    profile.primary_font && isGoogleFont(profile.primary_font)
      ? `"${profile.primary_font}", ui-sans-serif, system-ui, sans-serif`
      : '"Inter", ui-sans-serif, system-ui, sans-serif';
  const headlineFont =
    profile.secondary_font && isGoogleFont(profile.secondary_font)
      ? `"${profile.secondary_font}", ui-serif, Georgia, serif`
      : '"Instrument Serif", ui-serif, Georgia, serif';
  Object.assign(style, {
    "--card-foreground": "var(--foreground)",
    "--popover": "var(--card)",
    "--popover-foreground": "var(--foreground)",
    "--input": "var(--border)",
    "--font-sans": bodyFont,
    "--font-display": headlineFont,
    "--font-user-body": bodyFont,
    "--font-user-headline": headlineFont,
    "--product-background": "var(--background)",
    "--product-surface": "var(--card)",
    "--product-muted": "var(--muted)",
    "--product-text": "var(--foreground)",
    "--product-muted-text": "var(--muted-foreground)",
    "--product-border": "var(--border)",
    "--product-accent": accentHex,
    "--product-on-accent": style["--primary-foreground"],
    "--product-accent-foreground": style["--primary-foreground"],
    colorScheme: mode,
    fontFamily: "var(--font-sans)",
  });
  const pattern =
    profile.pattern && Object.hasOwn(PATTERN_BY_ID, profile.pattern)
      ? (profile.pattern as PatternId)
      : "none";
  const patternSettings: PatternSettings = {
    ...DEFAULT_SETTINGS,
    ...(profile.pattern_settings &&
    typeof profile.pattern_settings === "object" &&
    !Array.isArray(profile.pattern_settings)
      ? profile.pattern_settings
      : {}),
  };
  return { mode, accentHex, pattern, patternSettings, style };
}
