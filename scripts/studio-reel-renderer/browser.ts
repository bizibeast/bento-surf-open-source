import { renderStudioReel } from "../../src/lib/content-studio-reel-render";
import type { StudioMedia, StudioReel } from "../../src/lib/content-studio";
import { registerAacEncoder } from "@mediabunny/aac-encoder";
import fontUrl from "../../src/assets/carousel/Inter.ttf?inline";

registerAacEncoder();

type BrowserRenderInput = { document: StudioReel; assets: Omit<StudioMedia, "url" | "name">[] };

export async function render({ document, assets }: BrowserRenderInput) {
  const font = new FontFace("Inter", `url(${fontUrl})`, { weight: "100 900" });
  window.document.fonts.add(await font.load());
  const media = new Map(
    assets.map(({ id, kind }) => [
      id,
      { id, kind, name: "Studio asset", url: new URL(`/media/${id}`, location.href).href },
    ]),
  );
  const output = await renderStudioReel(document, { media, avatarUrls: new Map() }, () => {});
  if (output.size > 32 * 1024 * 1024) throw new Error("The output exceeds the hosted Reel limit.");
  const bytes = new Uint8Array(await output.arrayBuffer());
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x2000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x2000)));
  }
  return btoa(chunks.join(""));
}
