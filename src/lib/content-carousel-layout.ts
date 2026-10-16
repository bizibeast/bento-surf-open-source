import type { Font } from "opentype.js";
import type { CarouselSlide } from "./content-carousel";
import { colorOn, type AgentBranding } from "./content-agent-branding";

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
}) {
  const { slide, index, count, brand, font, portrait } = input;
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
  const bg = cover ? brand.accentColor : brand.backgroundColor;
  const fg = cover ? colorOn(bg) : brand.textColor;
  const headingY = photo ? 610 : 245;
  const available = photo ? 540 : 900;
  let heading: string[] = [],
    body: string[] = [],
    headingSize = 0,
    bodySize = 0;
  for (const scale of [1, 0.94, 0.88, 0.82, 0.76, 0.7]) {
    headingSize = Math.round(78 * scale);
    bodySize = Math.round(40 * scale);
    heading = wrapSlideText(slide.heading, font, headingSize, 904);
    body = wrapSlideText(slide.body, font, bodySize, 904);
    if (heading.length * headingSize * 1.18 + 48 + body.length * bodySize * 1.5 <= available) break;
    if (scale === 0.7) throw new Error(`Shorten slide ${index + 1} so all its copy fits.`);
  }
  const paths = (lines: string[], size: number, y: number, lineHeight: number, fill: string) =>
    lines
      .map((line, n) => {
        const path = font.getPath(line, 88, y + n * lineHeight, size);
        path.fill = fill;
        return path.toSVG(2);
      })
      .join("");
  const bodyY = headingY + heading.length * headingSize * 1.18 + 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1350" viewBox="0 0 1080 1350">
    <rect width="1080" height="1350" fill="${bg}"/>
    ${photo ? `<image x="0" y="0" width="1080" height="500" preserveAspectRatio="xMidYMid slice" xlink:href="data:${photo.mime};base64,${photo.base64}"/>` : `<rect x="88" y="120" width="90" height="8" rx="4" fill="${cover ? fg : brand.accentColor}"/>`}
    ${paths(heading, headingSize, headingY, headingSize * 1.18, fg)}
    ${paths(body, bodySize, bodyY, bodySize * 1.5, fg)}
    <rect x="88" y="1230" width="904" height="2" fill="${fg}" opacity=".2"/>
    ${paths([`${String(index + 1).padStart(2, "0")} / ${String(count).padStart(2, "0")}`], 24, 1280, 30, fg)}
  </svg>`;
}
