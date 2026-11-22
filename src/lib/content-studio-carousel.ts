import { parse } from "opentype.js";
import fontUrl from "@/assets/carousel/Inter.ttf?url";
import { carouselSvg } from "./content-carousel-layout";
import { studioCarouselPhotoId, type StudioCarousel, type StudioMedia } from "./content-studio";

let fontPromise: Promise<ReturnType<typeof parse>> | undefined;

function loadCarouselFont() {
  fontPromise ??= fetch(fontUrl)
    .then((response) => {
      if (!response.ok) throw new Error("The carousel font could not load.");
      return response.arrayBuffer();
    })
    .then(parse)
    .catch((error) => {
      fontPromise = undefined;
      throw error;
    });
  return fontPromise;
}

export async function loadStudioImage(url: string) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  await image.decode();
  return image;
}

export async function buildStudioCarouselSlide(
  document: StudioCarousel,
  index: number,
  media: Map<string, StudioMedia>,
) {
  const slide = document.slides[index];
  const selected = studioCarouselPhotoId(document, index);
  if (index === 0 && document.brand.coverStyle === "portrait" && !selected)
    throw new Error("Choose a cover portrait or switch to a text cover.");
  const asset = selected ? media.get(selected) : undefined;
  if (selected && asset?.kind !== "image") throw new Error("This slide's photo is unavailable.");
  const font = await loadCarouselFont();
  let portrait: { mime: string; base64: string } | undefined;
  if (asset) {
    const image = await loadStudioImage(asset.url).catch(() => {
      throw new Error("This slide's photo could not load.");
    });
    const canvas = window.document.createElement("canvas");
    const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not prepare this slide's photo.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    portrait = { mime: "image/jpeg", base64: canvas.toDataURL("image/jpeg", 0.93).split(",")[1] };
  }
  return carouselSvg({
    slide,
    index,
    count: document.slides.length,
    brand: document.brand,
    font,
    portrait,
    layout: document.layout,
  });
}

export async function carouselSvgToJpeg(svg: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = await loadStudioImage(url);
    const canvas = window.document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1350;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not export this slide.");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("This slide could not export."))),
        "image/jpeg",
        0.95,
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
