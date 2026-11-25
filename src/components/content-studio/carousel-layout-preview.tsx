import { useEffect, useState } from "react";
import { studioStarter, type StudioCarousel } from "@/lib/content-studio";
import type { AgentBranding } from "@/lib/content-agent-branding";

/** Starter cards show their real export layout, using the active workspace colors. */
export function CarouselLayoutPreview({
  layout,
  brand,
}: {
  layout: StudioCarousel["layout"];
  brand: AgentBranding;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    const created: string[] = [];
    const starter = studioStarter("carousel", layout, {
      ...brand,
      coverStyle: "text",
      heroPhotoId: null,
    });
    if (starter.document.format !== "carousel") return;
    const document = starter.document;
    void import("@/lib/content-studio-carousel")
      .then(async ({ buildStudioCarouselSlide }) => {
        const images = await Promise.all(
          document.slides.slice(0, 3).map(async (_, index) => {
            const svg = await buildStudioCarouselSlide(document, index, new Map());
            if (!active) return "";
            const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
            created.push(url);
            return url;
          }),
        );
        if (active) setUrls(images);
      })
      .catch(() => {
        if (active) setUrls([]);
      });
    return () => {
      active = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [layout, brand]);
  return (
    <span className="grid grid-cols-3 gap-1.5 rounded-lg bg-muted/40 p-2" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="aspect-[4/5] overflow-hidden rounded"
          style={{ background: index === 0 ? brand.accentColor : brand.backgroundColor }}
        >
          {urls[index] && <img className="h-full w-full object-contain" src={urls[index]} alt="" />}
        </span>
      ))}
    </span>
  );
}
