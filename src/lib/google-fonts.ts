// Curated list of popular Google Fonts, split by recommended use.
export const SANS_FONTS = [
  "Inter",
  "Manrope",
  "DM Sans",
  "Plus Jakarta Sans",
  "Work Sans",
  "Nunito",
  "Nunito Sans",
  "Poppins",
  "Montserrat",
  "Raleway",
  "Lato",
  "Roboto",
  "Open Sans",
  "Source Sans 3",
  "Mulish",
  "Karla",
  "Figtree",
  "Outfit",
  "Space Grotesk",
  "Sora",
  "Urbanist",
  "Epilogue",
  "Hind",
  "IBM Plex Sans",
  "Barlow",
  "Rubik",
  "Quicksand",
  "Cabin",
  "Archivo",
  "Albert Sans",
] as const;

export const DISPLAY_FONTS = [
  "Instrument Serif",
  "Playfair Display",
  "DM Serif Display",
  "Cormorant Garamond",
  "Libre Baskerville",
  "Lora",
  "Merriweather",
  "EB Garamond",
  "Fraunces",
  "Crimson Pro",
  "Bricolage Grotesque",
  "Syne",
  "Unbounded",
  "Bebas Neue",
  "Abril Fatface",
  "Archivo Black",
  "Anton",
  "Oswald",
  "Space Mono",
  "JetBrains Mono",
  "Bodoni Moda",
  "PT Serif",
  "Spectral",
  "Tinos",
] as const;

export const ALL_FONTS = Array.from(new Set([...SANS_FONTS, ...DISPLAY_FONTS])).sort();
const FONT_SET: ReadonlySet<string> = new Set(ALL_FONTS);

export function isGoogleFont(value: string): value is (typeof ALL_FONTS)[number] {
  return FONT_SET.has(value);
}

export function googleFontHref(family: string) {
  const f = family.trim().replace(/\s+/g, "+");
  // Request the family's default face instead of assuming that every font
  // supports the same weights. Several display fonts in our picker (Abril
  // Fatface, Anton, Bebas Neue, Instrument Serif, etc.) only publish a 400
  // face; asking Google Fonts for nonexistent 500/600/700 faces causes the
  // entire stylesheet request to fail and the UI silently falls back.
  return `https://fonts.googleapis.com/css2?family=${f}&display=swap`;
}
