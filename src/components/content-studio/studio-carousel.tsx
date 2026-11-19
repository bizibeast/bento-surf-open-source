import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  CAROUSEL_STARTERS,
  STUDIO_CAROUSEL_LAYOUTS,
  type StudioCarousel,
  moveStudioItem,
  type StudioMedia,
} from "@/lib/content-studio";
import { CAROUSEL_BODY_LIMIT, CAROUSEL_HEADING_LIMIT } from "@/lib/content-carousel";
import { buildStudioCarouselSlide } from "@/lib/content-studio-carousel";
import {
  StudioInput,
  StudioLabel,
  StudioMediaPicker,
  StudioOrder,
  StudioSelect,
  StudioTextarea,
} from "./studio-controls";

export function StudioCarouselEditor({
  document,
  onChange,
  assets,
  onMore,
  onUpload,
}: {
  document: StudioCarousel;
  onChange: (next: StudioCarousel) => void;
  assets: StudioMedia[];
  onMore?: () => void;
  onUpload: (file: File) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState({ url: "", error: "" });
  const index = Math.min(selected, document.slides.length - 1);
  const slide = document.slides[index];

  useEffect(() => {
    let current = true;
    let url: string | undefined;
    void buildStudioCarouselSlide(
      document,
      index,
      new Map(assets.map((asset) => [asset.id, asset])),
    )
      .then((svg) => {
        if (!current) return;
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setPreview({ url, error: "" });
      })
      .catch((error: Error) => {
        if (current)
          setPreview({ url: "", error: error.message || "This slide could not preview." });
      });
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [document, index, assets]);

  const update = (patch: Partial<typeof slide>) =>
    onChange({
      ...document,
      slides: document.slides.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    });

  return (
    <div className="studio-editor-grid">
      <section className="studio-preview-column">
        <div className="studio-preview studio-carousel-preview">
          {preview.url ? (
            <img src={preview.url} alt={slide.heading || `Slide ${index + 1} preview`} />
          ) : (
            <p>{preview.error || "Preparing slide preview…"}</p>
          )}
        </div>
        <div className="studio-timeline" aria-label="Slides">
          {document.slides.map((item, itemIndex) => (
            <button
              type="button"
              key={itemIndex}
              aria-pressed={index === itemIndex}
              className="studio-timeline-card"
              onClick={() => setSelected(itemIndex)}
            >
              <span>{itemIndex + 1}</span>
              <strong>{item.heading || "Untitled slide"}</strong>
            </button>
          ))}
          <button
            type="button"
            className="content-action"
            disabled={document.slides.length >= 10}
            onClick={() => {
              setSelected(document.slides.length);
              onChange({ ...document, slides: [...document.slides, { heading: "", body: "" }] });
            }}
          >
            <Plus size={16} /> Slide
          </button>
        </div>
      </section>
      <section className="studio-inspector">
        <StudioLabel label="Layout">
          <StudioSelect
            value={document.layout}
            onChange={(event) =>
              onChange({ ...document, layout: event.target.value as StudioCarousel["layout"] })
            }
          >
            {STUDIO_CAROUSEL_LAYOUTS.map((layout) => (
              <option key={layout} value={layout}>
                {CAROUSEL_STARTERS[layout].name}
              </option>
            ))}
          </StudioSelect>
        </StudioLabel>
        <div className="studio-toolbar">
          <h3>Slide {index + 1}</h3>
          <StudioOrder
            item="slide"
            index={index}
            count={document.slides.length}
            min={2}
            onMove={(delta) => {
              onChange({ ...document, slides: moveStudioItem(document.slides, index, delta) });
              setSelected(index + delta);
            }}
            onRemove={() =>
              onChange({
                ...document,
                slides: document.slides.filter((_, itemIndex) => itemIndex !== index),
              })
            }
          />
        </div>
        <StudioLabel label="Heading">
          <StudioInput
            value={slide.heading}
            maxLength={CAROUSEL_HEADING_LIMIT}
            onChange={(event) => update({ heading: event.target.value })}
          />
        </StudioLabel>
        <StudioLabel label="Body">
          <StudioTextarea
            rows={5}
            value={slide.body}
            maxLength={CAROUSEL_BODY_LIMIT}
            onChange={(event) => update({ body: event.target.value })}
          />
        </StudioLabel>
        <StudioMediaPicker
          assets={assets}
          value={slide.mediaId}
          kind="image"
          label="Slide image"
          onChange={(id) => update({ mediaId: id || undefined })}
        />
        <div className="studio-actions">
          <label className="content-action studio-upload">
            Upload image
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.target.value = "";
              }}
            />
          </label>
          {onMore && (
            <button type="button" className="content-action" onClick={onMore}>
              More media
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
