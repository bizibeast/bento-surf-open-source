import type { Font } from "opentype.js";
import type { CarouselSlide } from "./content-carousel";
import { colorOn, type AgentBranding } from "./content-agent-branding";
import type { StudioCarousel } from "./content-studio";

/** Measurements and paths use the same bundled font, so exported copy cannot silently clip. */
export function wrapSlideText(text: string, font: Font, size: number, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.trim().split(/\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (font.getAdvanceWidth(word, size) > width)
        throw new Error("A carousel word is too long. Shorten it before preparing slides.");
      const next = line ? `${line} ${word}` : word;
      if (line && font.getAdvanceWidth(next, size) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}
export function carouselSvg(input: {
  slide: CarouselSlide;
  index: number;
  count: number;
  brand: AgentBranding;
  font: Font;
  portrait?: { mime: string; base64: string };
  layout?: StudioCarousel["layout"];
}) {
  const { slide, index, count, brand, font, portrait, layout } = input;
  // Unsupported characters must be edited, never exported as empty boxes.
  if (
    Array.from(`${slide.heading}${slide.body}`).some(
      (c) => !/\s/.test(c) && !font.charToGlyph(c).index,
    )
  )
    throw new Error(
      "This template does not support a character in the slide. Remove emoji or use Latin text before preparing it.",
    );
  const cover = index === 0;
  const photo = portrait;
  const dark = cover || layout === "poster" || (layout === "split" && index % 2 === 0);
  const bg = dark ? brand.accentColor : brand.backgroundColor;
  const fg = dark ? colorOn(bg) : brand.textColor;
  const accent = dark ? fg : brand.accentColor;
  const x = layout === "split" || layout === "story" ? 150 : 88;
  const width = 992 - x;
  const centered = layout === "poster";
  const headingY = photo
    ? 610
    : layout === "quote" || layout === "metric"
      ? 380
      : centered
        ? 430
        : 245;
  const available = photo ? 540 : headingY > 300 ? 730 : 900;
  let heading: string[] = [],
    body: string[] = [],
    headingSize = 0,
    bodySize = 0;
  for (const scale of [1, 0.94, 0.88, 0.82, 0.76, 0.7]) {
    headingSize = Math.round((layout === "metric" || layout === "quote" ? 100 : 78) * scale);
    bodySize = Math.round(40 * scale);
    heading = wrapSlideText(slide.heading, font, headingSize, width);
    body = wrapSlideText(slide.body, font, bodySize, width);
    if (heading.length * headingSize * 1.18 + 48 + body.length * bodySize * 1.5 <= available) break;
    if (scale === 0.7) throw new Error(`Shorten slide ${index + 1} so all its copy fits.`);
  }
  const paths = (lines: string[], size: number, y: number, lineHeight: number, fill: string) =>
    lines
      .map((line, n) => {
        const left = centered ? (1080 - font.getAdvanceWidth(line, size)) / 2 : x;
        const path = font.getPath(line, left, y + n * lineHeight, size);
        path.fill = fill;
        return path.toSVG(2);
      })
      .join("");
  const bodyY = headingY + heading.length * headingSize * 1.18 + 40;
  const number = paths([String(index + 1).padStart(2, "0")], 38, 150, 46, accent);
  const ornaments = {
    editorial: `<rect x="88" y="120" width="90" height="8" rx="4" fill="${accent}"/>`,
    checklist: `<rect x="88" y="90" width="85" height="85" rx="14" stroke="${accent}" stroke-width="6" fill="none"/><path d="M106 135l17 17 33-35" fill="none" stroke="${accent}" stroke-width="7"/>`,
    split: `<rect x="0" width="104" height="1350" fill="${fg}" opacity=".13"/><rect x="0" y="110" width="104" height="16" fill="${accent}"/>`,
    story: `<path d="M88 97v1090" stroke="${accent}" opacity=".5" stroke-width="3"/><circle cx="88" cy="135" r="14" fill="${accent}"/>${number}`,
    metric: `<path d="M88 300h904 M88 240h904 M88 180h904 M88 120h904" fill="none" stroke="${accent}" stroke-width="2" opacity=".34"/><path d="M88 290l280-95 180 48 380-117" fill="none" stroke="${accent}" stroke-width="9"/>`,
    quote: paths(["“"], 240, 330, 48, accent),
    steps: `<rect x="68" y="93" width="93" height="86" rx="44" fill="${accent}" fill-opacity=".19"/>${number}`,
    catalog: `<rect x="44" y="65" width="992" height="1130" rx="35" fill="none" stroke="${accent}" stroke-width="2"/><path d="M88 155h172m-172 26h80" stroke="${accent}" stroke-width="5" opacity=".65"/>`,
    poster: `<circle cx="540" cy="150" r="118" fill="${fg}" opacity=".14"/><circle cx="540" cy="150" r="78" fill="none" stroke="${fg}" stroke-width="3" opacity=".72"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1350" viewBox="0 0 1080 1350">
    <rect width="1080" height="1350" fill="${bg}"/>
    ${photo ? `<image x="0" y="0" width="1080" height="500" preserveAspectRatio="xMidYMid slice" xlink:href="data:${photo.mime};base64,${photo.base64}"/>` : ornaments[layout || "editorial"]}
    ${paths(heading, headingSize, headingY, headingSize * 1.18, fg)}
    ${paths(body, bodySize, bodyY, bodySize * 1.5, fg)}
    <rect x="88" y="1230" width="904" height="2" fill="${fg}" opacity=".2"/>
    ${paths([`${String(index + 1).padStart(2, "0")} / ${String(count).padStart(2, "0")}`], 24, 1280, 30, fg)}
  </svg>`;
}
