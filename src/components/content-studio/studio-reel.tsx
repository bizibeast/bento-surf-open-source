import { useEffect, useRef, useState } from "react";
import { Pause, Play, Plus } from "lucide-react";
import {
  newReelScene,
  REEL_STARTERS,
  reelTimeline,
  STUDIO_REEL_STYLES,
  type ReelScene,
  moveStudioItem,
  type StudioMedia,
  type StudioReel,
} from "@/lib/content-studio";
import { loadStudioImage } from "@/lib/content-studio-carousel";
import { drawStudioReelScene, REEL_HEIGHT, REEL_WIDTH } from "@/lib/content-studio-reel-draw";
import { studioReelAsset } from "@/lib/content-studio-reel-render";
import { reviseReelScene } from "@/lib/content-studio-avatar";
import { reelSceneDirection } from "@/lib/content-creation-harness";
import {
  StudioInput,
  StudioLabel,
  StudioMediaPicker,
  StudioOrder,
  StudioSelect,
  StudioTextarea,
} from "./studio-controls";

export function StudioReelEditor({
  document,
  onChange,
  assets,
  avatarUrls,
  onMore,
  onUpload,
}: {
  document: StudioReel;
  onChange: (next: StudioReel) => void;
  assets: StudioMedia[];
  avatarUrls: Map<string, string>;
  onMore?: () => void;
  onUpload: (file: File) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const index = Math.min(selected, document.scenes.length - 1);
  const scene = document.scenes[index];
  const direction = reelSceneDirection(document, scene, index);
  const timeline = reelTimeline(document);
  const duration = timeline.at(-1)!.end;
  const asset = studioReelAsset(scene, {
    media: new Map(assets.map((item) => [item.id, item])),
    avatarUrls,
  });

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const context = ctx;
    let active = true;
    let animation = 0;
    let video: HTMLVideoElement | undefined;
    setPreviewError("");
    function paint(seconds: number, image?: HTMLImageElement) {
      const sample =
        video && video.readyState >= 2 && video.videoWidth
          ? { image: video, width: video.videoWidth, height: video.videoHeight }
          : image
            ? { image, width: image.naturalWidth, height: image.naturalHeight }
            : undefined;
      drawStudioReelScene(context, document, scene, index, seconds, sample);
    }
    function preview(image?: HTMLImageElement) {
      if (!active) return;
      paint(playing ? 0 : Math.min(0.4, scene.duration), image);
      if (!playing) return;
      const started = performance.now();
      const tick = (now: number) => {
        if (!active) return;
        const seconds = video
          ? Math.max(0, video.currentTime - scene.sourceStart)
          : (now - started) / 1000;
        paint(Math.min(seconds, scene.duration), image);
        setCurrentSeconds(Math.min(seconds, scene.duration));
        if (seconds < scene.duration && !video?.ended) {
          animation = requestAnimationFrame(tick);
        } else {
          setPlaying(false);
        }
      };
      animation = requestAnimationFrame(tick);
    }
    function fail() {
      if (!active) return;
      setPreviewError("This scene's media could not be previewed.");
      setPlaying(false);
    }
    if (asset?.kind === "video") {
      video = window.document.createElement("video");
      video.crossOrigin = "anonymous";
      video.preload = "auto";
      video.muted = scene.mute;
      video.playsInline = true;
      video.addEventListener("error", fail);
      video.addEventListener("loadedmetadata", () => {
        if (!video || !active) return;
        if (scene.sourceStart >= video.duration) {
          fail();
          return;
        }
        video.currentTime = scene.sourceStart;
      });
      video.addEventListener(
        "loadeddata",
        () => {
          if (!video || !active) return;
          if (!playing) preview();
        },
        { once: true },
      );
      video.addEventListener("seeked", () => {
        if (!video || !active) return;
        if (!playing) preview();
      });
      video.src = asset.url;
      if (playing) {
        void video
          .play()
          .then(() => preview())
          .catch(fail);
      }
    } else if (asset?.kind === "image") {
      void loadStudioImage(asset.url).then(preview).catch(fail);
    } else {
      preview();
    }
    return () => {
      active = false;
      cancelAnimationFrame(animation);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [document, scene, index, asset?.kind, asset?.url, playing]);

  const patch = (updated: Partial<ReelScene>) => {
    setPlaying(false);
    setCurrentSeconds(0);
    onChange({
      ...document,
      scenes: document.scenes.map((item) =>
        item.id === scene.id ? reviseReelScene(item, updated) : item,
      ),
    });
  };

  return (
    <div className="studio-editor-grid">
      <section className="studio-preview-column">
        <div className="studio-preview studio-reel-preview">
          <canvas
            ref={canvasRef}
            width={REEL_WIDTH}
            height={REEL_HEIGHT}
            aria-label="Reel scene preview"
          />
        </div>
        <div className="studio-toolbar">
          <button
            className="content-action"
            type="button"
            onClick={() => {
              setPlaying(!playing);
              setCurrentSeconds(0);
            }}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
            {playing ? "Pause" : "Play scene"}
          </button>
          <span className="studio-muted">
            {(timeline[index].start + currentSeconds).toFixed(1)} / {duration}s
          </span>
        </div>
        {(previewError || (scene.kind !== "card" && !asset)) && (
          <p role="status" className="studio-muted">
            {previewError || "Choose or generate media to preview this scene."}
          </p>
        )}
        <div className="studio-timeline" aria-label="Reel timeline">
          {timeline.map(({ scene: item, start, end }, sceneIndex) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={index === sceneIndex}
              className="studio-timeline-card"
              style={{ minWidth: Math.max(110, Math.min(220, item.duration * 27)) }}
              onClick={() => {
                setSelected(sceneIndex);
                setPlaying(false);
                setCurrentSeconds(0);
              }}
            >
              <span>
                {start}–{end}s
              </span>
              <strong>{item.title || `Scene ${sceneIndex + 1}`}</strong>
            </button>
          ))}
          <button
            type="button"
            className="content-action"
            disabled={document.scenes.length >= 20 || duration >= 90}
            onClick={() => {
              setSelected(document.scenes.length);
              setPlaying(false);
              setCurrentSeconds(0);
              onChange({
                ...document,
                scenes: [
                  ...document.scenes,
                  newReelScene({ duration: Math.min(4, 90 - duration) }),
                ],
              });
            }}
          >
            <Plus size={16} /> Scene
          </button>
        </div>
      </section>
      <section className="studio-inspector">
        <StudioLabel label="Scene layout">
          <StudioSelect
            value={direction.layout}
            disabled={scene.kind === "avatar"}
            onChange={(event) =>
              patch({
                direction: { ...direction, layout: event.target.value as typeof direction.layout },
              })
            }
          >
            <option value="statement">Bold statement</option>
            <option value="stack">Staged cards</option>
            <option value="split">Split frame</option>
            <option value="full-bleed">Full frame</option>
          </StudioSelect>
        </StudioLabel>
        <StudioLabel label="Scene motion">
          <StudioSelect
            value={direction.motion}
            onChange={(event) =>
              patch({
                direction: { ...direction, motion: event.target.value as typeof direction.motion },
              })
            }
          >
            <option value="rise">Rise</option>
            <option value="slide">Slide</option>
            <option value="punch">Punch</option>
          </StudioSelect>
        </StudioLabel>
        <StudioLabel label="Editing style">
          <StudioSelect
            value={document.style}
            onChange={(event) =>
              onChange({ ...document, style: event.target.value as StudioReel["style"] })
            }
          >
            {STUDIO_REEL_STYLES.map((style) => (
              <option key={style} value={style}>
                {REEL_STARTERS[style].name}
              </option>
            ))}
          </StudioSelect>
        </StudioLabel>
        <div className="studio-toolbar">
          <h3>Scene {index + 1}</h3>
          <StudioOrder
            item="scene"
            index={index}
            count={timeline.length}
            min={1}
            onMove={(delta) => {
              setSelected(index + delta);
              setPlaying(false);
              setCurrentSeconds(0);
              onChange({ ...document, scenes: moveStudioItem(document.scenes, index, delta) });
            }}
            onRemove={() => {
              setPlaying(false);
              setCurrentSeconds(0);
              onChange({
                ...document,
                scenes: document.scenes.filter((item) => item.id !== scene.id),
              });
            }}
          />
        </div>
        <StudioLabel label="Title">
          <StudioInput
            value={scene.title}
            maxLength={64}
            onChange={(event) => patch({ title: event.target.value })}
          />
        </StudioLabel>
        <StudioLabel label="Caption">
          <StudioTextarea
            rows={3}
            value={scene.caption}
            maxLength={160}
            onChange={(event) => patch({ caption: event.target.value })}
          />
        </StudioLabel>
        <div className="studio-dual">
          <StudioLabel label="Duration (seconds)">
            <StudioInput
              type="number"
              step={0.01}
              min={0.25}
              max={Math.min(20, 90 - duration + scene.duration)}
              value={scene.duration}
              onChange={(event) => {
                const value = Number(event.target.value);
                patch({
                  duration: Math.min(20, 90 - duration + scene.duration, Math.max(0.25, value)),
                });
              }}
            />
          </StudioLabel>
          <StudioLabel label="Visual">
            <StudioSelect
              value={scene.kind}
              onChange={(event) =>
                patch({
                  kind: event.target.value as ReelScene["kind"],
                  mediaId: null,
                  sourceStart: 0,
                })
              }
            >
              <option value="card">Text card</option>
              <option value="media">Workspace media</option>
              <option value="avatar">Avatar</option>
            </StudioSelect>
          </StudioLabel>
        </div>
        {scene.kind !== "card" && (
          <>
            <StudioMediaPicker
              assets={assets}
              value={scene.mediaId}
              kind={scene.kind === "avatar" ? "video" : undefined}
              label={scene.kind === "avatar" ? "Reuse an avatar clip" : "Scene media"}
              onChange={(id) => patch({ mediaId: id, sourceStart: 0 })}
            />
            <div className="studio-actions">
              <label className="content-action studio-upload">
                Upload media
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
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
            {asset?.kind === "video" && (
              <div className="studio-dual">
                <StudioLabel label="Clip starts at (seconds)">
                  <StudioInput
                    type="number"
                    value={scene.sourceStart}
                    min={0}
                    max={600}
                    step={0.1}
                    onChange={(event) =>
                      patch({ sourceStart: Math.max(0, Math.min(600, Number(event.target.value))) })
                    }
                  />
                </StudioLabel>
                <label className="studio-check">
                  <input
                    type="checkbox"
                    checked={scene.mute}
                    onChange={(event) => patch({ mute: event.target.checked })}
                  />{" "}
                  Mute clip
                </label>
              </div>
            )}
          </>
        )}
        {(!scene.mediaId || scene.kind !== "avatar") && (
          <StudioLabel label={scene.kind === "avatar" ? "Spoken script" : "Narration script"}>
            <StudioTextarea
              rows={3}
              value={scene.avatarScript}
              maxLength={450}
              onChange={(event) => patch({ avatarScript: event.target.value })}
            />
          </StudioLabel>
        )}
        <StudioLabel label="Background music">
          <StudioMediaPicker
            assets={assets}
            kind="video"
            value={document.audio?.musicMediaId ?? null}
            label="Music source"
            onChange={(id) =>
              onChange({
                ...document,
                audio: {
                  narrationVolume: 1,
                  musicVolume: 0.12,
                  sourceStart: 0,
                  ...document.audio,
                  musicMediaId: id,
                },
              })
            }
          />
          <span className="studio-muted">
            Use audio from an owned, licensed clip. It plays quietly beneath narration.
          </span>
        </StudioLabel>
        {document.audio?.musicMediaId && (
          <StudioLabel label="Music volume">
            <StudioInput
              type="range"
              min={0}
              max={0.3}
              step={0.01}
              value={document.audio.musicVolume}
              onChange={(event) =>
                onChange({
                  ...document,
                  audio: { ...document.audio!, musicVolume: Number(event.target.value) },
                })
              }
            />
          </StudioLabel>
        )}
        <details className="space-y-3 rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Timed subtitles</summary>
          {(document.subtitles || [])
            .map((cue, cueIndex) => ({ cue, cueIndex }))
            .filter(
              ({ cue }) => cue.start >= timeline[index].start && cue.start < timeline[index].end,
            )
            .map(({ cue, cueIndex }) => (
              <div className="mt-3 space-y-2" key={cueIndex}>
                <StudioInput
                  aria-label={`Subtitle ${cueIndex + 1} text`}
                  value={cue.text}
                  maxLength={120}
                  onChange={(event) =>
                    onChange({
                      ...document,
                      subtitles: document.subtitles!.map((item, i) =>
                        i === cueIndex ? { ...item, text: event.target.value } : item,
                      ),
                    })
                  }
                />
                <div className="studio-dual">
                  {(["start", "end"] as const).map((field) => (
                    <StudioInput
                      key={field}
                      aria-label={`Subtitle ${cueIndex + 1} ${field}`}
                      type="number"
                      min={0}
                      max={duration}
                      step={0.01}
                      value={cue[field]}
                      onChange={(event) =>
                        onChange({
                          ...document,
                          subtitles: document.subtitles!.map((item, i) =>
                            i === cueIndex
                              ? { ...item, [field]: Number(event.target.value) }
                              : item,
                          ),
                        })
                      }
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="content-action"
                  onClick={() =>
                    onChange({
                      ...document,
                      subtitles: document.subtitles!.filter((_, i) => i !== cueIndex),
                    })
                  }
                >
                  Remove subtitle {cueIndex + 1}
                </button>
              </div>
            ))}
          <button
            type="button"
            className="content-action"
            disabled={(document.subtitles?.length || 0) >= 300}
            onClick={() => {
              const start = Math.max(
                timeline[index].start,
                ...(document.subtitles || [])
                  .filter((cue) => cue.start < timeline[index].end)
                  .map((cue) => cue.end),
              );
              if (start >= timeline[index].end) return;
              onChange({
                ...document,
                subtitles: [
                  ...(document.subtitles || []),
                  {
                    start,
                    end: Math.min(start + 2, timeline[index].end),
                    text: scene.caption || scene.title || "New subtitle",
                  },
                ].sort((a, b) => a.start - b.start),
              });
            }}
          >
            Add subtitle
          </button>
        </details>
      </section>
    </div>
  );
}
