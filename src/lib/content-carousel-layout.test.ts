// @vitest-environment node
import { readFileSync } from "node:fs";
import { parse } from "opentype.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { beforeAll, expect, it } from "vitest";
import { carouselSvg, wrapSlideText } from "./content-carousel-layout";
import {
  agentBrandingSchema,
  DEFAULT_AGENT_BRANDING,
  contrastRatio,
  colorOn,
} from "./content-agent-branding";
const bytes = readFileSync(new URL("../assets/carousel/Inter.ttf", import.meta.url));
const font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
beforeAll(async () => {
  await initWasm(readFileSync("node_modules/@resvg/resvg-wasm/index_bg.wasm"));
});
it("renders actual 1080×1350 image bytes with all copy converted to safe paths", () => {
  const svg = carouselSvg({
    slide: {
      heading: "Make one useful promise",
      body: "A specific point of view gives your reader something to remember. Start with one practical example, then show what changed.",
    },
    index: 0,
    count: 3,
    brand: DEFAULT_AGENT_BRANDING,
    font,
  });
  expect(svg).not.toContain("<text");
  const renderer = new Resvg(svg);
  const image = renderer.render();
  expect([image.width, image.height]).toEqual([1080, 1350]);
  expect([...image.asPng().slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  image.free();
  renderer.free();
});
it("wraps using actual glyph widths and refuses clipped or unsupported content", () => {
  for (const line of wrapSlideText("Wide words WWWW mixed with thin iii words", font, 70, 600))
    expect(font.getAdvanceWidth(line, 70)).toBeLessThanOrEqual(600);
  expect(() =>
    carouselSvg({
      slide: { heading: "A heading", body: "word ".repeat(800) },
      index: 0,
      count: 2,
      brand: DEFAULT_AGENT_BRANDING,
      font,
    }),
  ).toThrow(/Shorten/);
  expect(() =>
    carouselSvg({
      slide: { heading: "你好", body: "Example" },
      index: 0,
      count: 2,
      brand: DEFAULT_AGENT_BRANDING,
      font,
    }),
  ).toThrow(/does not support/);
});
it("rejects unreadable brand combinations and keeps cover text legible", () => {
  expect(
    agentBrandingSchema.safeParse({ textColor: "#ffffff", backgroundColor: "#ffffff" }).success,
  ).toBe(false);
  expect(agentBrandingSchema.safeParse({ accentColor: 'red"/><script>' }).success).toBe(false);
  for (const bg of ["#ffffff", "#000000", "#ffcc00", "#5533bb"])
    expect(contrastRatio(bg, colorOn(bg))).toBeGreaterThanOrEqual(4.5);
});
