import { toJpeg } from "html-to-image";

export function assertSlideFits(node: HTMLElement) {
  for (const text of node.querySelectorAll<HTMLElement>("[data-slide-copy]")) {
    if (text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1)
      throw new Error("Slide text does not fit. Shorten the heading or body before exporting.");
  }
}
export async function renderCarouselImage(node: HTMLElement) {
  await document.fonts?.ready;
  assertSlideFits(node);
  const background = node.dataset.carouselBackground;
  if (background) {
    // Fail closed if the reviewed owned background cannot be decoded; exporting just the overlay would be misleading.
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = background;
    await image.decode().catch(() => {
      throw new Error("The slide background could not load. Retry before exporting.");
    });
  }
  const data = await toJpeg(node, {
    quality: 0.94,
    pixelRatio: 1,
    width: 1080,
    height: 1350,
    backgroundColor: getComputedStyle(node).backgroundColor,
  });
  return (await fetch(data)).blob();
}
/** Cache survives an interrupted upload; attachment is committed only after all slides succeed. */
export async function exportCarouselSlides(
  nodes: HTMLElement[],
  cache: Map<number, string>,
  dependencies: {
    renderImage: (node: HTMLElement) => Promise<Blob>;
    upload: (file: File, index: number) => Promise<string>;
  },
) {
  if (nodes.length < 2 || nodes.length > 10)
    throw new Error("A complete carousel needs 2–10 slides.");
  const ids: string[] = [];
  for (let index = 0; index < nodes.length; index++) {
    let id = cache.get(index);
    if (!id) {
      const blob = await dependencies.renderImage(nodes[index]);
      id = await dependencies.upload(
        new File([blob], `slide-${index + 1}.jpg`, { type: "image/jpeg" }),
        index,
      );
      cache.set(index, id);
    }
    ids.push(id);
  }
  return ids;
}
