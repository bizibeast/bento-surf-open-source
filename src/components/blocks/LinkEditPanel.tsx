import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link as LinkIcon,
  Type,
  FileText,
  Palette,
  Sparkles,
  Image as ImageIcon,
  Check,
  MousePointerClick,
  Pencil,
  Quote as QuoteIcon,
  User,
  Briefcase,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Code2,
  MapPin,
  Video,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { uploadFile } from "@/lib/upload";
import { googleMapsEmbedUrl } from "@/lib/embeds";
import { geocodeMapLocation } from "@/lib/map.functions";
import { PersistentMap } from "./PersistentMap";
import {
  normalizeSocialEmbedContent,
  socialEmbedProviderFromContent,
  socialEmbedHelp,
  socialEmbedLabel,
  socialEmbedSourceUrl,
  socialEmbedUrl,
} from "@/lib/social-embeds";
import type { BlockContent } from "./BlockRenderer";
import { errorMessage } from "@/lib/errors";
import { FileDropzone } from "./FileDropzone";

export type LinkContent = BlockContent;

type Props = {
  blockId: string;
  blockType?: string;
  anchorRect: DOMRect | null;
  content: LinkContent;
  currentIconUrl?: string | null;
  onChange: (next: LinkContent) => void;
  onClose: () => void;
  isCustomLink: boolean;
  tileW?: number;
  tileH?: number;
};

const COLORS = [
  "#ffffff",
  "#d8d8d8",
  "#7cc1ef",
  "#3d8de0",
  "#2e5fa1",
  "#f5cf3a",
  "#e89a2e",
  "#e7702a",
  "#d2474b",
  "#d3479d",
  "#9f6df0",
  "#5dbf9a",
  "#0a0a0a",
  "#3f3f3f",
];

const CTA_COLORS = [
  "#ffffff",
  "#d8d8d8",
  "#7cc1ef",
  "#3d8de0",
  "#2e5fa1",
  "#f5cf3a",
  "#e89a2e",
  "#e7702a",
  "#3f3f3f",
  "#0a0a0a",
  "#e3b8e5",
  "#d3479d",
  "#5dbf9a",
  "#d2474b",
];

const MATERIALS: { key: "fill" | "gradient" | "transparent" | "glass"; label: string }[] = [
  { key: "fill", label: "Fill" },
  { key: "gradient", label: "Gradient" },
  { key: "transparent", label: "Transparent" },
  { key: "glass", label: "Glass" },
];

function normalizePanelContent(
  value: LinkContent,
  provider: ReturnType<typeof socialEmbedProviderFromContent>,
) {
  if (!provider) return value;
  const originalUrl = socialEmbedSourceUrl(provider, String(value.originalUrl || value.url || ""));
  return originalUrl ? { ...value, originalUrl } : value;
}

function videoEmbedProvider(blockType: string | undefined, content: LinkContent) {
  return blockType === "video" ? socialEmbedProviderFromContent(content) : null;
}

function materialPreviewStyle(
  key: "gradient" | "transparent" | "glass" | "fill",
  color: string,
): React.CSSProperties {
  switch (key) {
    case "fill":
      return { background: `color-mix(in oklab, ${color} 20%, white)` };
    case "gradient":
      return {
        background: `linear-gradient(135deg, color-mix(in oklab, ${color} 35%, white), color-mix(in oklab, ${color} 85%, black 8%))`,
      };
    case "transparent":
      return {
        backgroundImage:
          "linear-gradient(45deg,#e5e5e5 25%,transparent 25%),linear-gradient(-45deg,#e5e5e5 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e5e5 75%),linear-gradient(-45deg,transparent 75%,#e5e5e5 75%)",
        backgroundSize: "8px 8px",
        backgroundPosition: "0 0,0 4px,4px -4px,-4px 0",
      };
    case "glass":
      return {
        background: `linear-gradient(135deg, color-mix(in oklab, ${color} 12%, rgba(255,255,255,0.78)), rgba(255,255,255,0.38))`,
        backdropFilter: "blur(14px) saturate(190%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -10px 18px rgba(255,255,255,0.28), 0 8px 20px rgba(15,23,42,0.08)",
      };
  }
}

function PanelSection({
  id,
  icon: Icon,
  label,
  children,
  openSections,
  toggleSection,
}: {
  id: string;
  icon: LucideIcon;
  label: string;
  children?: React.ReactNode;
  openSections: Set<string>;
  toggleSection: (id: string) => void;
}) {
  const open = openSections.has(id);
  return (
    <div
      className={`overflow-hidden rounded-2xl transition-colors duration-200 ${open ? "bg-neutral-100" : "bg-neutral-50 hover:bg-neutral-100/70"}`}
    >
      <button
        type="button"
        onClick={() => toggleSection(id)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
      >
        <Icon
          className="size-[18px] text-neutral-700 transition-transform duration-200"
          style={{ transform: open ? "scale(1.05)" : "scale(1)" }}
        />
        <span className="font-sans text-[15px] font-semibold text-neutral-900">{label}</span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {children && <div className="px-4 pb-4">{children}</div>}
        </div>
      </div>
    </div>
  );
}

export function LinkEditPanel({
  blockId,
  blockType,
  anchorRect,
  content,
  currentIconUrl,
  onChange,
  onClose,
  isCustomLink,
  tileW,
  tileH,
}: Props) {
  const isQuote = blockType === "quote";
  const isImage = blockType === "image";
  const isText = blockType === "heading";
  const isMap = blockType === "map";
  const isSocial = blockType === "social_link";
  const isExperience = blockType === "experience";
  const isWidget = blockType === "generic_link" && content?.kind === "widget";
  const socialEmbedProvider = videoEmbedProvider(blockType, content);
  const isLatestYoutube = blockType === "video" && content?.liveProvider === "youtube";
  const isVideo = blockType === "video" && !socialEmbedProvider && !isLatestYoutube;
  const panelRef = useRef<HTMLDivElement>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(
    () =>
      new Set(
        isImage
          ? ["image"]
          : isText
            ? ["text"]
            : isMap
              ? ["map"]
              : isLatestYoutube
                ? ["youtube-latest"]
                : socialEmbedProvider
                  ? ["social-embed"]
                  : isVideo
                    ? ["url"]
                    : isWidget
                      ? ["widget"]
                      : isExperience
                        ? ["experience"]
                        : isSocial
                          ? ["audience"]
                          : [],
      ),
  );
  const toggleSection = (id: string) =>
    setOpenSections((prev) => {
      const next = new Set<string>();
      if (!prev.has(id)) next.add(id);
      return next;
    });

  const [closing, setClosing] = useState(false);
  const [hoverIcon, setHoverIcon] = useState(false);
  const [draft, setDraft] = useState<LinkContent>(() =>
    normalizePanelContent(content ?? {}, socialEmbedProvider),
  );
  const [locatingMap, setLocatingMap] = useState(false);

  useEffect(() => {
    setDraft(normalizePanelContent(content ?? {}, socialEmbedProvider));
    // The panel intentionally keeps local typing state while the same block is
    // autosaved; a new block receives a freshly normalized source URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 160);
  };

  const panelWidth = Math.min(320, typeof window === "undefined" ? 320 : window.innerWidth - 16);
  const PANEL_H_EST = 520;
  const [panelH, setPanelH] = useState(PANEL_H_EST);
  useEffect(() => {
    if (!panelRef.current) return;
    const el = panelRef.current;
    const measure = () => setPanelH(el.offsetHeight || PANEL_H_EST);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { pos, placeRight } = useMemo(() => {
    if (!anchorRect) return { pos: { left: 8, top: 8 }, placeRight: true };
    const gap = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = vw <= 640 ? 8 : 12;
    const tileCenter = anchorRect.left + anchorRect.width / 2;
    const right = tileCenter < vw / 2;
    const left = right ? anchorRect.right + gap : anchorRect.left - panelWidth - gap;
    // Default: align panel top with tile top.
    // If panel would overflow viewport bottom, align panel bottom with tile bottom (last-row case).
    let top = anchorRect.top;
    if (top + panelH + pad > vh) {
      top = anchorRect.bottom - panelH;
    }
    top = Math.max(pad, top);
    const clampedLeft = Math.max(pad, Math.min(left, vw - panelWidth - pad));
    return { pos: { left: clampedLeft, top }, placeRight: right };
  }, [anchorRect, panelH, panelWidth]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      const tile = document.querySelector(`[data-block-id="${blockId}"]`);
      if (tile && tile.contains(t)) return;
      requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);

  const isSquare2 = tileW === 2 && tileH === 2;

  const set = (k: string, v: BlockContent[string]) => {
    if (isSquare2) {
      if (k === "ctaEnabled" && v && (draft.description ?? "").trim()) {
        toast.error("Turn off description or change tile size to enable CTA");
        return;
      }
      if (k === "description" && (v ?? "").trim() && draft.ctaEnabled) {
        toast.error("Turn off CTA or change tile size to add a description");
        return;
      }
    }
    setDraft((current) => {
      const next = { ...current, [k]: v };
      onChange(next);
      return next;
    });
  };

  const setMapLocation = (location: string) => {
    setDraft((current) => {
      const { mapLat: _mapLat, mapLng: _mapLng, mapZoom: _mapZoom, ...rest } = current;
      const next = { ...rest, location };
      onChange(next);
      return next;
    });
  };

  const resolveMapLocation = async () => {
    const location = String(draft.location ?? "").trim();
    if (!location || locatingMap) return;
    try {
      setLocatingMap(true);
      const view = await geocodeMapLocation({ data: { location } });
      setDraft((current) => {
        if (String(current.location ?? "").trim() !== location) return current;
        const next = { ...current, ...view };
        onChange(next);
        return next;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not locate this place");
    } finally {
      setLocatingMap(false);
    }
  };

  const setSocialEmbedSource = (originalUrl: string) => {
    if (!socialEmbedProvider) return;
    setDraft((current) => {
      const next = normalizeSocialEmbedContent(socialEmbedProvider, { ...current, originalUrl });
      onChange(next);
      return next;
    });
  };

  const setTwitterEmbedTheme = (twitterTheme: "light" | "dark") => {
    if (socialEmbedProvider !== "twitter") return;
    setDraft((current) => {
      const next = normalizeSocialEmbedContent("twitter", { ...current, twitterTheme });
      onChange(next);
      return next;
    });
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const uploadIcon = async (file: File) => {
    try {
      const publicUrl = await uploadFile(file, "image");
      set("customIcon", publicUrl);
      toast.success("Icon updated");
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Upload failed"));
    }
  };
  const uploadImage = async (file: File) => {
    try {
      setUploadingImage(true);
      const publicUrl = await uploadFile(file, "image");
      set("url", publicUrl);
      toast.success("Image uploaded");
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Upload failed"));
    } finally {
      setUploadingImage(false);
    }
  };

  const currentColor = draft.color || "#3d8de0";
  const currentIcon = draft.customIcon || currentIconUrl || draft.image || draft.favicon;

  const inputCls =
    "w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none shadow-none ring-0 transition-colors focus:bg-white";

  const anim = closing ? "opacity-0 scale-95 translate-x-2" : "opacity-100 scale-100 translate-x-0";
  const originX = placeRight ? "0%" : "100%";

  return (
    <div
      ref={panelRef}
      className={`fixed z-50 w-[min(320px,calc(100vw-1rem))] rounded-[28px] bg-white p-3 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.35)] transition-all duration-200 ease-out ${anim}`}
      style={{
        left: pos.left,
        top: pos.top,
        maxHeight: "calc(100dvh - 16px)",
        overflowY: "auto",
        transformOrigin: `${originX} 24px`,
      }}
    >
      <div className="space-y-2">
        {isQuote ? (
          <>
            <PanelSection
              id="quote"
              icon={QuoteIcon}
              label="Quote"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <textarea
                value={draft.title ?? ""}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Enter your quote..."
                rows={4}
                className={inputCls + " resize-none"}
              />
            </PanelSection>
            <PanelSection
              id="author"
              icon={User}
              label="Author"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <input
                value={draft.description ?? ""}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Author name"
                className={inputCls}
              />
            </PanelSection>

            <PanelSection
              id="color"
              icon={Palette}
              label="Color"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              {draft.material === "transparent" ? (
                <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-700">
                  Remove transparent material to select color
                </div>
              ) : (
                <div className="grid grid-cols-8 gap-2">
                  <button
                    type="button"
                    onClick={() => set("color", null)}
                    className={`flex aspect-square items-center justify-center rounded-lg border transition-transform duration-150 hover:scale-110 ${!draft.color ? "border-neutral-900" : "border-transparent"}`}
                    title="Auto"
                    style={{
                      background:
                        "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f87171)",
                    }}
                  >
                    {!draft.color && <Check className="size-3 text-white drop-shadow" />}
                  </button>
                  {COLORS.map((c) => {
                    const sel = draft.color === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => set("color", c)}
                        className={`aspect-square rounded-lg border transition-transform duration-150 hover:scale-110 ${sel ? "border-neutral-900" : "border-transparent"}`}
                        style={{ background: c }}
                      />
                    );
                  })}
                  <label className="relative flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-dashed border-neutral-300 hover:border-neutral-400">
                    <Palette className="size-3.5 text-neutral-400" />
                    <input
                      type="color"
                      className="absolute inset-0 opacity-0"
                      value={draft.color || "#3d8de0"}
                      onChange={(e) => set("color", e.target.value)}
                    />
                  </label>
                </div>
              )}
            </PanelSection>

            <PanelSection
              id="material"
              icon={Sparkles}
              label="Material"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <div className="grid grid-cols-4 gap-2">
                {MATERIALS.map((m) => {
                  const sel = (draft.material ?? "fill") === m.key;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => set("material", m.key)}
                      className={`group flex flex-col items-center gap-1.5 rounded-xl border p-2 text-[10px] font-medium text-neutral-700 transition-all duration-150 hover:-translate-y-0.5 hover:bg-white ${sel ? "border-neutral-900 bg-white" : "border-transparent"}`}
                    >
                      <div
                        className="size-10 rounded-lg overflow-hidden transition-transform duration-200 group-hover:scale-105"
                        style={materialPreviewStyle(m.key, currentColor)}
                      />
                      <span className="truncate w-full text-center leading-tight">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </PanelSection>
          </>
        ) : isMap ? (
          <>
            <PanelSection
              id="map"
              icon={MapPin}
              label="Google Map"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <input
                value={draft.location ?? ""}
                onChange={(e) => setMapLocation(e.target.value)}
                onBlur={() => void resolveMapLocation()}
                placeholder="City, landmark, or address"
                className={inputCls}
              />
              <input
                value={draft.title ?? ""}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Label (optional)"
                className={inputCls + " mt-2"}
              />
              {draft.location?.trim() && (
                <div className="relative mt-3 aspect-[2/1] overflow-hidden rounded-xl bg-neutral-200">
                  {Number.isFinite(Number(draft.mapLat)) &&
                  Number.isFinite(Number(draft.mapLng)) &&
                  Number.isFinite(Number(draft.mapZoom)) ? (
                    <PersistentMap
                      mapLat={Number(draft.mapLat)}
                      mapLng={Number(draft.mapLng)}
                      mapZoom={Number(draft.mapZoom)}
                      interactive={false}
                    />
                  ) : (
                    <iframe
                      title={`Map preview of ${draft.location}`}
                      src={googleMapsEmbedUrl(draft.location)}
                      className="size-full border-0"
                      loading="lazy"
                    />
                  )}
                  {locatingMap && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs font-medium text-neutral-700 backdrop-blur-sm">
                      Finding location…
                    </div>
                  )}
                </div>
              )}
            </PanelSection>
          </>
        ) : isText ? (
          <>
            <PanelSection
              id="text"
              icon={Type}
              label="Text"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <textarea
                value={draft.title ?? draft.text ?? ""}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Write something lovely…"
                rows={4}
                className={inputCls + " resize-none text-base font-medium"}
              />
              <div className="mt-3">
                <p className="mb-2 text-xs font-medium text-neutral-600">Heading size</p>
                <div className="grid grid-cols-6 gap-1 rounded-xl bg-neutral-100 p-1">
                  {(["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((level) => {
                    const selected = (draft.headingLevel ?? "h2") === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        aria-label={level.toUpperCase()}
                        aria-pressed={selected}
                        onClick={() => set("headingLevel", level)}
                        className={`rounded-lg px-1 py-2 text-xs font-semibold transition ${
                          selected
                            ? "bg-neutral-900 text-white shadow-sm"
                            : "text-neutral-600 hover:bg-white hover:text-neutral-900"
                        }`}
                      >
                        {level.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              </div>
            </PanelSection>
            <PanelSection
              id="text-color"
              icon={Palette}
              label="Text color"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <div className="grid grid-cols-8 gap-2">
                <button
                  type="button"
                  aria-label="Use theme text color"
                  onClick={() => set("textColor", null)}
                  className={`flex aspect-square items-center justify-center rounded-lg border transition-transform duration-150 hover:scale-110 ${!draft.textColor ? "border-neutral-900" : "border-transparent"}`}
                  style={{
                    background:
                      "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f87171)",
                  }}
                >
                  {!draft.textColor && <Check className="size-3 text-white drop-shadow" />}
                </button>
                {COLORS.map((color) => {
                  const selected = draft.textColor === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use ${color} text color`}
                      onClick={() => set("textColor", color)}
                      className={`aspect-square rounded-lg border transition-transform duration-150 hover:scale-110 ${selected ? "border-neutral-900" : "border-transparent"}`}
                      style={{ background: color }}
                    />
                  );
                })}
                <label className="relative flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-dashed border-neutral-300 hover:border-neutral-400">
                  <Palette className="size-3.5 text-neutral-400" />
                  <input
                    type="color"
                    aria-label="Custom text color"
                    className="absolute inset-0 opacity-0"
                    value={draft.textColor || "#0a0a0a"}
                    onChange={(e) => set("textColor", e.target.value)}
                  />
                </label>
              </div>
            </PanelSection>
            <PanelSection
              id="appearance"
              icon={Sparkles}
              label="Appearance"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <label className="flex items-center justify-between rounded-xl bg-white px-3 py-2.5">
                <span className="text-sm text-neutral-800">Show block and shadow</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.shadow !== false}
                  onClick={() => set("shadow", draft.shadow === false)}
                  className={`relative h-5 w-9 rounded-full transition-colors ${draft.shadow !== false ? "bg-[#3478f6]" : "bg-neutral-300"}`}
                >
                  <span
                    className="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all"
                    style={{ left: draft.shadow !== false ? 18 : 2 }}
                  />
                </button>
              </label>
              <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                Turn this off for clean text that sits directly on your page.
              </p>
            </PanelSection>
          </>
        ) : isLatestYoutube ? (
          <PanelSection
            id="youtube-latest"
            icon={Video}
            label="Recent YouTube video"
            openSections={openSections}
            toggleSection={toggleSection}
          >
            <div className="flex items-center gap-2 rounded-xl bg-white px-3.5 py-2.5">
              <span className="text-neutral-400">@</span>
              <input
                value={draft.handle ?? ""}
                onChange={(e) => set("handle", e.target.value)}
                placeholder="channel handle"
                className="min-w-0 flex-1 bg-transparent text-sm text-neutral-800 outline-none"
              />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              This block automatically follows the channel&apos;s newest public upload.
            </p>
          </PanelSection>
        ) : socialEmbedProvider ? (
          <>
            <PanelSection
              id="social-embed"
              icon={Video}
              label={socialEmbedLabel(socialEmbedProvider)}
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <input
                value={draft.originalUrl ?? ""}
                onChange={(e) => setSocialEmbedSource(e.target.value)}
                placeholder={
                  socialEmbedProvider === "twitter"
                    ? "https://x.com/creator/status/..."
                    : "https://..."
                }
                className={inputCls}
              />
              <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                {socialEmbedHelp(socialEmbedProvider)}
              </p>
              {socialEmbedProvider === "twitter" && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-neutral-600">Appearance</p>
                  <div className="grid grid-cols-2 gap-1 rounded-xl bg-white p-1">
                    {(["light", "dark"] as const).map((theme) => {
                      const active = (draft.twitterTheme ?? "light") === theme;
                      return (
                        <button
                          key={theme}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setTwitterEmbedTheme(theme)}
                          className={`rounded-lg px-3 py-2 text-xs font-medium capitalize transition-colors ${
                            active
                              ? theme === "dark"
                                ? "bg-neutral-900 text-white"
                                : "bg-neutral-100 text-neutral-900 shadow-sm"
                              : "text-neutral-500 hover:text-neutral-800"
                          }`}
                        >
                          {theme === "light" ? "Light" : "Dark"}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {!!draft.originalUrl?.trim() &&
                !socialEmbedUrl(socialEmbedProvider, draft.originalUrl) && (
                  <p className="mt-2 text-xs font-medium text-rose-600">
                    Paste a supported public link to update this block.
                  </p>
                )}
            </PanelSection>
            {socialEmbedProvider === "youtube" && (
              <PanelSection
                id="title"
                icon={Type}
                label="Text tag"
                openSections={openSections}
                toggleSection={toggleSection}
              >
                <input
                  value={draft.title ?? ""}
                  onChange={(e) => set("title", e.target.value)}
                  placeholder="Add a text tag"
                  className={inputCls}
                />
                <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                  Display a short label over the video.
                </p>
              </PanelSection>
            )}
          </>
        ) : isWidget ? (
          <>
            <PanelSection
              id="widget"
              icon={Code2}
              label="Widget"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <input
                value={draft.title ?? ""}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Widget title"
                className={inputCls}
              />
              <textarea
                value={draft.widgetUrl ?? ""}
                onChange={(e) => set("widgetUrl", e.target.value)}
                placeholder="https://widgets.example.com/..."
                rows={5}
                className={inputCls + " mt-2 resize-none font-mono text-xs"}
              />
              <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                Only HTTPS widget URLs are embedded, inside a restricted sandbox.
              </p>
            </PanelSection>
          </>
        ) : isExperience ? (
          <ExperienceEditor
            draft={draft}
            setDraft={(next) => {
              setDraft(next);
              onChange(next);
            }}
          />
        ) : (
          <>
            {isImage ? (
              <PanelSection
                id="image"
                icon={ImageIcon}
                label="Image"
                openSections={openSections}
                toggleSection={toggleSection}
              >
                <label
                  className="group relative block aspect-video w-full cursor-pointer overflow-hidden rounded-xl bg-neutral-100 transition-transform duration-200 hover:scale-[1.01]"
                  title="Click to upload"
                >
                  {draft.url ? (
                    <img src={draft.url} alt="" className="size-full object-cover" />
                  ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-1 text-neutral-500">
                      <ImageIcon className="size-6" />
                      <span className="text-xs">
                        {uploadingImage ? "Uploading..." : "Click to upload"}
                      </span>
                    </div>
                  )}
                  {draft.url && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                      <Pencil className="size-5 text-white" />
                    </div>
                  )}
                  <input
                    ref={imageFileRef}
                    type="file"
                    accept="image/*"
                    className="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadImage(f);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              </PanelSection>
            ) : null}

            {(isImage || !isImage) && (
              <PanelSection
                id="url"
                icon={LinkIcon}
                label={isVideo ? "Video" : "URL"}
                openSections={openSections}
                toggleSection={toggleSection}
              >
                {isVideo && (
                  <>
                    <FileDropzone
                      kind="video"
                      value={draft.url ?? ""}
                      onChange={(value) => set("url", value)}
                      label="Upload video"
                      className="mb-3"
                    />
                    <div className="mb-3 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
                      <span className="h-px flex-1 bg-neutral-200" />
                      or add a URL
                      <span className="h-px flex-1 bg-neutral-200" />
                    </div>
                  </>
                )}
                <input
                  value={(isImage ? draft.linkUrl : draft.url) ?? ""}
                  onChange={(e) => set(isImage ? "linkUrl" : "url", e.target.value)}
                  placeholder={isVideo ? "https://example.com/video.mp4" : "https://..."}
                  className={inputCls}
                />
                <p className="mt-2 text-xs text-neutral-500">
                  {isVideo
                    ? "Paste a direct or supported video URL"
                    : "Paste the link to any web page"}
                </p>
              </PanelSection>
            )}

            <PanelSection
              id="title"
              icon={Type}
              label={isVideo ? "Text tag" : "Title"}
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <input
                value={draft.title ?? ""}
                onChange={(e) => set("title", e.target.value)}
                placeholder={isVideo ? "Add a text tag" : "Title"}
                className={inputCls}
              />
              {isVideo && (
                <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                  Display a short label over the video.
                </p>
              )}
            </PanelSection>

            {!isVideo && (
              <PanelSection
                id="description"
                icon={FileText}
                label="Description"
                openSections={openSections}
                toggleSection={toggleSection}
              >
                <textarea
                  value={draft.description ?? ""}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="Brief link description..."
                  rows={3}
                  className={inputCls + " resize-none"}
                />
              </PanelSection>
            )}

            {isSocial && draft.platform === "github" && (
              <PanelSection
                id="audience"
                icon={User}
                label="GitHub activity"
                openSections={openSections}
                toggleSection={toggleSection}
              >
                <label className="flex items-center justify-between rounded-xl bg-white px-3 py-2.5">
                  <span className="text-sm text-neutral-800">Show live activity chart</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={draft.showGraph !== false}
                    onClick={() => set("showGraph", draft.showGraph === false)}
                    className={`relative h-5 w-9 rounded-full transition-colors ${draft.showGraph !== false ? "bg-[#3478f6]" : "bg-neutral-300"}`}
                  >
                    <span
                      className="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all"
                      style={{ left: draft.showGraph !== false ? 18 : 2 }}
                    />
                  </button>
                </label>
                <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                  Bento refreshes the public contribution chart automatically.
                </p>
              </PanelSection>
            )}

            {isCustomLink && (
              <PanelSection
                id="icon"
                icon={ImageIcon}
                label="Icon"
                openSections={openSections}
                toggleSection={toggleSection}
              >
                <div
                  className="group relative size-16 cursor-pointer overflow-hidden rounded-xl bg-white transition-transform duration-200 hover:scale-[1.03]"
                  onClick={() => fileRef.current?.click()}
                  onMouseEnter={() => setHoverIcon(true)}
                  onMouseLeave={() => setHoverIcon(false)}
                  title="Click to change icon"
                >
                  {currentIcon ? (
                    <img src={currentIcon} alt="" className="size-full object-cover" />
                  ) : (
                    <div className="flex size-full items-center justify-center">
                      <ImageIcon className="size-6 text-neutral-400" />
                    </div>
                  )}
                  <div
                    className={`absolute inset-0 flex items-center justify-center bg-black/45 transition-opacity duration-150 ${hoverIcon ? "opacity-100" : "opacity-0"}`}
                  >
                    <Pencil className="size-5 text-white" />
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadIcon(f);
                    }}
                  />
                </div>
              </PanelSection>
            )}

            <PanelSection
              id="color"
              icon={Palette}
              label="Color"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <div className="grid grid-cols-8 gap-2">
                <button
                  type="button"
                  onClick={() => set("color", null)}
                  className={`flex aspect-square items-center justify-center rounded-lg border transition-transform duration-150 hover:scale-110 ${!draft.color ? "border-neutral-900" : "border-transparent"}`}
                  title="Auto"
                  style={{
                    background:
                      "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f87171)",
                  }}
                >
                  {!draft.color && <Check className="size-3 text-white drop-shadow" />}
                </button>
                {COLORS.map((c) => {
                  const sel = draft.color === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => set("color", c)}
                      className={`aspect-square rounded-lg border transition-transform duration-150 hover:scale-110 ${sel ? "border-neutral-900" : "border-transparent"}`}
                      style={{ background: c }}
                    />
                  );
                })}
                <label className="relative flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-dashed border-neutral-300 hover:border-neutral-400">
                  <Palette className="size-3.5 text-neutral-400" />
                  <input
                    type="color"
                    className="absolute inset-0 opacity-0"
                    value={draft.color || "#3d8de0"}
                    onChange={(e) => set("color", e.target.value)}
                  />
                </label>
              </div>
            </PanelSection>

            <PanelSection
              id="material"
              icon={Sparkles}
              label="Material"
              openSections={openSections}
              toggleSection={toggleSection}
            >
              <div className="grid grid-cols-4 gap-2">
                {MATERIALS.map((m) => {
                  const sel = (draft.material ?? "fill") === m.key;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => set("material", m.key)}
                      className={`group flex flex-col items-center gap-1.5 rounded-xl border p-2 text-[10px] font-medium text-neutral-700 transition-all duration-150 hover:-translate-y-0.5 hover:bg-white ${sel ? "border-neutral-900 bg-white" : "border-transparent"}`}
                    >
                      <div
                        className="size-10 rounded-lg overflow-hidden transition-transform duration-200 group-hover:scale-105"
                        style={materialPreviewStyle(m.key, currentColor)}
                      />
                      <span className="truncate w-full text-center leading-tight">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </PanelSection>

            {!isImage && !isVideo && (
              <PanelSection
                id="cta"
                icon={MousePointerClick}
                label="CTA"
                openSections={openSections}
                toggleSection={toggleSection}
              >
                <div className="space-y-3">
                  <label className="flex items-center justify-between rounded-xl bg-white px-3 py-2.5">
                    <span className="text-sm text-neutral-800">Show CTA button</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!draft.ctaEnabled}
                      onClick={() => set("ctaEnabled", !draft.ctaEnabled)}
                      className={`relative h-5 w-9 rounded-full transition-colors duration-200 ${draft.ctaEnabled ? "bg-neutral-900" : "bg-neutral-300"}`}
                    >
                      <span
                        className="absolute top-0.5 size-4 rounded-full bg-white shadow transition-all duration-200"
                        style={{ left: draft.ctaEnabled ? 18 : 2 }}
                      />
                    </button>
                  </label>

                  <input
                    value={draft.ctaLabel ?? "Visit"}
                    onChange={(e) => set("ctaLabel", e.target.value)}
                    placeholder="Visit Website"
                    className={inputCls}
                  />

                  <div>
                    <div className="mb-1.5 px-1 text-[11px] font-medium text-neutral-500">
                      Button color
                    </div>
                    <div className="grid grid-cols-8 gap-2">
                      <button
                        type="button"
                        onClick={() => set("ctaBgColor", null)}
                        className={`flex aspect-square items-center justify-center rounded-lg border transition-transform duration-150 hover:scale-110 ${!draft.ctaBgColor ? "border-neutral-900" : "border-transparent"}`}
                        title="Auto"
                        style={{
                          background:
                            "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f87171)",
                        }}
                      >
                        {!draft.ctaBgColor && <Check className="size-3 text-white drop-shadow" />}
                      </button>
                      {CTA_COLORS.map((c) => {
                        const sel = draft.ctaBgColor === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => set("ctaBgColor", c)}
                            className={`aspect-square rounded-lg border transition-transform duration-150 hover:scale-110 ${sel ? "border-neutral-900" : "border-transparent"}`}
                            style={{ background: c }}
                          />
                        );
                      })}
                      <label className="relative flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-dashed border-neutral-300 hover:border-neutral-400">
                        <Palette className="size-3.5 text-neutral-400" />
                        <input
                          type="color"
                          className="absolute inset-0 opacity-0"
                          value={draft.ctaBgColor || "#3d8de0"}
                          onChange={(e) => set("ctaBgColor", e.target.value)}
                        />
                      </label>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 px-1 text-[11px] font-medium text-neutral-500">
                      Text color
                    </div>
                    <div className="grid grid-cols-8 gap-2">
                      <button
                        type="button"
                        onClick={() => set("ctaTextColor", null)}
                        className={`flex aspect-square items-center justify-center rounded-lg border transition-transform duration-150 hover:scale-110 ${!draft.ctaTextColor ? "border-neutral-900" : "border-transparent"}`}
                        title="Auto"
                        style={{
                          background:
                            "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f87171)",
                        }}
                      >
                        {!draft.ctaTextColor && <Check className="size-3 text-white drop-shadow" />}
                      </button>
                      {CTA_COLORS.map((c) => {
                        const sel = draft.ctaTextColor === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => set("ctaTextColor", c)}
                            className={`aspect-square rounded-lg border transition-transform duration-150 hover:scale-110 ${sel ? "border-neutral-900" : "border-transparent"}`}
                            style={{ background: c }}
                          />
                        );
                      })}
                      <label className="relative flex aspect-square cursor-pointer items-center justify-center rounded-lg border border-dashed border-neutral-300 hover:border-neutral-400">
                        <Palette className="size-3.5 text-neutral-400" />
                        <input
                          type="color"
                          className="absolute inset-0 opacity-0"
                          value={draft.ctaTextColor || "#0a0a0a"}
                          onChange={(e) => set("ctaTextColor", e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </PanelSection>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type ExperienceItem = {
  id: string;
  company: string;
  position?: string;
  from?: string;
  to?: string;
  logo?: string;
};

function ExperienceEditor({
  draft,
  setDraft,
}: {
  draft: LinkContent;
  setDraft: (next: LinkContent) => void;
}) {
  const items: ExperienceItem[] = Array.isArray(draft.items) ? draft.items : [];
  const [activeId, setActiveId] = useState<string>(() => items[0]?.id ?? "");
  const logoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!items.find((i) => i.id === activeId)) {
      setActiveId(items[0]?.id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const active = items.find((i) => i.id === activeId);

  const updateItems = (next: ExperienceItem[]) => {
    setDraft({ ...draft, items: next });
  };
  const patchActive = (patch: Partial<ExperienceItem>) => {
    if (!active) return;
    updateItems(items.map((i) => (i.id === active.id ? { ...i, ...patch } : i)));
  };
  const addItem = () => {
    const item: ExperienceItem = {
      id:
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : String(Date.now()),
      company: "",
      position: "",
      from: "",
      to: "",
      logo: "",
    };
    updateItems([...items, item]);
    setActiveId(item.id);
  };
  const deleteActive = () => {
    if (!active) return;
    updateItems(items.filter((i) => i.id !== active.id));
  };
  const moveActive = (direction: -1 | 1) => {
    if (!active) return;
    const currentIndex = items.findIndex((i) => i.id === active.id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= items.length) return;
    const next = [...items];
    [next[currentIndex], next[nextIndex]] = [next[nextIndex], next[currentIndex]];
    updateItems(next);
  };

  const uploadLogo = async (file: File) => {
    try {
      const publicUrl = await uploadFile(file, "image");
      patchActive({ logo: publicUrl });
      toast.success("Logo updated");
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Upload failed"));
    }
  };

  const inputCls =
    "w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-sm text-neutral-800 outline-none shadow-none ring-0 transition-colors focus:bg-white";

  return (
    <div className="rounded-2xl bg-neutral-100 p-3">
      <div className="mb-3 flex items-center gap-2 px-1">
        <Briefcase className="size-[18px] text-neutral-700" />
        <span className="font-sans text-[15px] font-semibold text-neutral-900">Experience</span>
      </div>

      {/* Tabs */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {items.map((it) => {
          const sel = it.id === activeId;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => setActiveId(it.id)}
              className={`flex max-w-[140px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                sel
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "bg-white/50 text-neutral-600 hover:bg-white/80"
              }`}
            >
              <span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-200">
                {it.logo ? (
                  <img src={it.logo} alt="" className="size-full object-cover" />
                ) : (
                  <Briefcase className="size-2.5 text-neutral-500" />
                )}
              </span>
              <span className="truncate">{it.company || "Untitled"}</span>
            </button>
          );
        })}
      </div>

      {active ? (
        <div className="space-y-2 rounded-xl bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => logoRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-200"
            >
              {active.logo ? (
                <img src={active.logo} alt="" className="size-4 rounded object-cover" />
              ) : (
                <ImageIcon className="size-3.5" />
              )}
              {active.logo ? "Change logo" : "Add logo"}
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => moveActive(-1)}
                disabled={items.indexOf(active) === 0}
                aria-label="Move experience earlier"
                className="inline-flex size-8 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => moveActive(1)}
                disabled={items.indexOf(active) === items.length - 1}
                aria-label="Move experience later"
                className="inline-flex size-8 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ArrowDown className="size-3.5" />
              </button>
            </div>
          </div>
          <input
            ref={logoRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadLogo(f);
              e.currentTarget.value = "";
            }}
          />

          <input
            value={active.company}
            onChange={(e) => patchActive({ company: e.target.value })}
            placeholder="Company name"
            className={inputCls + " bg-neutral-100"}
          />
          <input
            value={active.position ?? ""}
            onChange={(e) => patchActive({ position: e.target.value })}
            placeholder="Position"
            className={inputCls + " bg-neutral-100"}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={active.from ?? ""}
              onChange={(e) => patchActive({ from: e.target.value })}
              placeholder="From"
              className={inputCls + " bg-neutral-100"}
            />
            <input
              value={active.to ?? ""}
              onChange={(e) => patchActive({ to: e.target.value })}
              placeholder="To"
              className={inputCls + " bg-neutral-100"}
            />
          </div>

          <button
            type="button"
            onClick={deleteActive}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-100"
          >
            <Trash2 className="size-3.5" />
            Delete item
          </button>
        </div>
      ) : (
        <div className="rounded-xl bg-white p-4 text-center text-xs text-neutral-500">
          No items yet.
        </div>
      )}

      <button
        type="button"
        onClick={addItem}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-300 bg-white px-3 py-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        <Plus className="size-3.5" />
        Add item
      </button>
    </div>
  );
}
