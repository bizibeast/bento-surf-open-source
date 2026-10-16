import { useRef, useState } from "react";
import { assertSlideFits } from "@/lib/content-carousel-export";
import { carouselCopyIssues, type CarouselSlide } from "@/lib/content-carousel";
import { agentBranding, colorOn, type AgentBranding } from "@/lib/content-agent-branding";

export function CarouselSlideCanvas({
  slide,
  index,
  count,
  backgroundUrl,
  branding,
}: {
  slide: CarouselSlide;
  index: number;
  count: number;
  backgroundUrl?: string;
  branding?: AgentBranding;
}) {
  const cover = index === 0;
  const brand = agentBranding(branding);
  return (
    <div
      data-carousel-slide={index}
      data-carousel-background={backgroundUrl}
      style={{
        width: 1080,
        height: 1350,
        boxSizing: "border-box",
        padding: 88,
        background: backgroundUrl
          ? `linear-gradient(rgba(23,33,58,.86),rgba(23,33,58,.86)), url("${backgroundUrl}") center / cover`
          : cover
            ? brand.accentColor
            : brand.backgroundColor,
        color: backgroundUrl ? "#fff" : cover ? colorOn(brand.accentColor) : brand.textColor,
        fontFamily: "Inter, sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: 44,
        overflow: "hidden",
      }}
    >
      <div style={{ fontSize: 24, letterSpacing: 4, textTransform: "uppercase" }}>
        {cover
          ? "A useful starting point"
          : index === count - 1
            ? "Your next step"
            : "One idea to try"}
      </div>
      <h2
        data-slide-copy
        style={{
          margin: 0,
          fontFamily: '"Instrument Serif", Georgia, serif',
          fontSize: 86,
          lineHeight: 1.06,
          fontWeight: 400,
          height: 390,
          flexShrink: 0,
          overflow: "hidden",
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
        }}
      >
        {slide.heading}
      </h2>
      <div
        data-slide-copy
        style={{
          fontSize: 42,
          lineHeight: 1.4,
          height: 590,
          flexShrink: 0,
          overflow: "hidden",
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
        }}
      >
        {slide.body}
      </div>
      <div style={{ marginTop: "auto", fontSize: 22 }}>
        {String(index + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}
      </div>
    </div>
  );
}
export function ContentCarouselDraft({
  slides,
  editing = false,
  onChange,
  onExport,
  disabled = false,
  backgrounds = {},
  branding,
  renderedUrls,
}: {
  slides: CarouselSlide[];
  editing?: boolean;
  onChange?: (slides: CarouselSlide[]) => void;
  onExport?: (nodes: HTMLElement[]) => Promise<void>;
  disabled?: boolean;
  backgrounds?: Record<string, string>;
  branding?: AgentBranding;
  renderedUrls?: string[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const issues = carouselCopyIssues(slides);
  return (
    <section aria-label="Carousel slides" className="my-4 min-w-0">
      <div ref={container} className="flex gap-3 overflow-x-auto pb-3">
        {slides.map((slide, index) => (
          <div key={index} className="shrink-0" style={{ width: 216 }}>
            <div style={{ width: 216, height: 270, overflow: "hidden", borderRadius: 8 }}>
              {!editing && renderedUrls?.length === slides.length ? (
                <img
                  src={renderedUrls[index]}
                  alt={`Slide ${index + 1}: ${slide.heading}`}
                  width={216}
                  height={270}
                />
              ) : (
                <div style={{ transform: "scale(.2)", transformOrigin: "top left" }}>
                  <CarouselSlideCanvas
                    slide={slide}
                    index={index}
                    count={slides.length}
                    branding={branding}
                    backgroundUrl={slide.mediaId ? backgrounds[slide.mediaId] : undefined}
                  />
                </div>
              )}
            </div>
            {editing && (
              <div className="mt-2 grid gap-2">
                <label className="text-xs">
                  Slide {index + 1} heading
                  <input
                    aria-label={`Slide ${index + 1} heading`}
                    className="content-field w-full"
                    value={slide.heading}
                    onChange={(e) =>
                      onChange?.(
                        slides.map((s, i) => (i === index ? { ...s, heading: e.target.value } : s)),
                      )
                    }
                  />
                </label>
                <label className="text-xs">
                  Slide {index + 1} body
                  <textarea
                    aria-label={`Slide ${index + 1} body`}
                    className="content-field w-full"
                    rows={5}
                    value={slide.body}
                    onChange={(e) =>
                      onChange?.(
                        slides.map((s, i) => (i === index ? { ...s, body: e.target.value } : s)),
                      )
                    }
                  />
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
      {issues.map((issue) => (
        <p key={issue} className="my-2 text-xs text-amber-800">
          {issue}
        </p>
      ))}
      {onExport && (
        <button
          type="button"
          className="content-action"
          disabled={disabled || editing || pending || issues.length > 0}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              const nodes = Array.from(
                container.current?.querySelectorAll<HTMLElement>("[data-carousel-slide]") || [],
              );
              await document.fonts?.ready;
              nodes.forEach(assertSlideFits);
              await onExport(nodes);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Images could not be exported.");
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Exporting…" : "Export images"}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
