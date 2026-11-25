import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { DEFAULT_AGENT_BRANDING, type AgentBranding } from "@/lib/content-agent-branding";
import type { StudioCarousel } from "@/lib/content-studio";

import { carouselLooks } from "@/lib/content-carousel-looks";

export function CarouselStyleGallery({
  brand,
  onChange,
  layout = "editorial",
}: {
  brand: AgentBranding;
  onChange: (brand: AgentBranding) => void;
  layout?: StudioCarousel["layout"];
}) {
  const [previews, setPreviews] = useState<string[][]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    void import("@/lib/content-studio-carousel")
      .then(async ({ buildStudioCarouselSlide }) => {
        const images = await Promise.all(
          carouselLooks.map(async (look) => {
            const document: StudioCarousel = {
              schemaVersion: 1,
              format: "carousel",
              layout,
              brand: { ...DEFAULT_AGENT_BRANDING, ...look },
              slides: [
                { heading: "An idea worth sharing.", body: "Your perspective, in your own voice." },
                { heading: "One useful takeaway.", body: "Give your reader a step to try today." },
              ],
            };
            return Promise.all(
              [0, 1].map(async (index) => {
                const svg = await buildStudioCarouselSlide(document, index, new Map());
                if (!active) return "";
                const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
                urls.push(url);
                return url;
              }),
            );
          }),
        );
        if (active) {
          setPreviews(images);
          setFailed(false);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [layout]);
  const match = carouselLooks.find((look) =>
    (["accentColor", "backgroundColor", "textColor"] as const).every(
      (k) => brand[k].toLowerCase() === look[k].toLowerCase(),
    ),
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Choose a look</p>
        <span className="text-xs text-muted-foreground">{match?.name || "Custom colors"}</span>
      </div>
      <div
        className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-3"
        role="group"
        aria-label="Carousel looks"
      >
        {carouselLooks.map((look, index) => {
          const selected = match?.name === look.name;
          return (
            <button
              type="button"
              key={look.name}
              aria-label={`Use ${look.name}`}
              aria-pressed={selected}
              onClick={() =>
                onChange({
                  ...brand,
                  accentColor: look.accentColor,
                  backgroundColor: look.backgroundColor,
                  textColor: look.textColor,
                })
              }
              className={`min-w-0 overflow-hidden rounded-xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-background hover:border-primary/60"}`}
            >
              <div className="mb-3 grid grid-cols-2 gap-1.5" aria-hidden="true">
                {[0, 1].map((slide) => (
                  <div
                    key={slide}
                    className="aspect-[4/5] overflow-hidden rounded-md"
                    style={{ background: slide ? look.backgroundColor : look.accentColor }}
                  >
                    {previews[index]?.[slide] && (
                      <img
                        className="h-full w-full object-contain"
                        src={previews[index][slide]}
                        alt=""
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="mb-2 flex gap-1.5" aria-hidden="true">
                {[look.accentColor, look.backgroundColor, look.textColor].map((color) => (
                  <span
                    key={color}
                    className="size-4 rounded-full border border-black/15"
                    style={{ background: color }}
                  />
                ))}
              </div>
              <strong className="text-sm">{look.name}</strong>
              <p className="mt-1 text-xs text-muted-foreground">{look.description}</p>
              <span
                className={`mt-3 flex min-h-7 items-center gap-1.5 text-xs ${selected ? "font-medium text-primary" : "text-muted-foreground"}`}
              >
                {selected && <Check size={14} aria-hidden="true" />}
                {selected ? "In use" : "Use this look"}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {failed
          ? "Slide previews could not load. Color choices are still available."
          : "Sample slides use Bento’s export layout and bundled typeface. Fine-tune colors in the brand controls."}
      </p>
    </div>
  );
}
