import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm?module";
import fontUrl from "@/assets/carousel/Inter.ttf?inline";
import { parse } from "opentype.js";
import { carouselSvg } from "./content-carousel-layout";
let initialized: Promise<void> | undefined;
let font: ReturnType<typeof parse> | undefined;

export async function renderAgentCarouselSlide(
  input: Omit<Parameters<typeof carouselSvg>[0], "font">,
) {
  initialized ??= initWasm(wasm);
  await initialized;
  if (!font) {
    const base64 = fontUrl.split(",")[1];
    if (!base64) throw new Error("The carousel font is unavailable.");
    font = parse(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer);
  }
  const renderer = new Resvg(carouselSvg({ ...input, font }));
  try {
    const image = renderer.render();
    try {
      return image.asPng().slice();
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
