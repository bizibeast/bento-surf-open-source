// Modular pattern registry. Add new patterns by appending to PATTERNS and
// implementing a renderer in src/components/patterns/PatternBackdrop.tsx.

export type PatternId =
  | "none"
  | "custom_photo"
  | "flicker"
  | "grid"
  | "retro"
  | "ripple"
  | "striped"
  | "aurora"
  | "waves"
  | "particles"
  | "ether"
  | "bends"
  | "veil"
  | "dots"
  | "lines"
  | "grain"
  | "glitch"
  | "rays"
  | "pixels"
  | "mesh"
  | "silk";

export type PatternMeta = {
  id: PatternId;
  label: string;
  hint: string;
  engine: "css" | "canvas" | "webgl" | "photo" | "none";
  supportsBlur?: boolean;
  supportsOverlay?: boolean;
  defaults?: { intensity?: number; opacity?: number; blur?: number };
};

export const PATTERNS: PatternMeta[] = [
  {
    id: "custom_photo",
    label: "Custom Photo",
    hint: "Upload any image",
    engine: "photo",
    supportsBlur: true,
    supportsOverlay: true,
    defaults: { intensity: 50, opacity: 100, blur: 0 },
  },
  { id: "none", label: "None", hint: "Solid color only", engine: "none" },
  { id: "flicker", label: "Flicker", hint: "Mathematics notebook", engine: "canvas" },
  { id: "grid", label: "Grid", hint: "Graph paper", engine: "canvas" },
  { id: "retro", label: "Retro", hint: "Synthwave floor", engine: "webgl" },
  { id: "ripple", label: "Ripple", hint: "Water drops", engine: "webgl" },
  { id: "striped", label: "Striped", hint: "Diagonal stripes", engine: "css" },
  { id: "aurora", label: "Aurora", hint: "Northern lights", engine: "webgl" },
  { id: "waves", label: "Waves", hint: "Flowing lines", engine: "canvas" },
  { id: "particles", label: "Particles", hint: "Click to explode", engine: "canvas" },
  { id: "ether", label: "Ether", hint: "Cursor energy", engine: "webgl" },
  { id: "bends", label: "Bends", hint: "Glowing ribbons", engine: "webgl" },
  { id: "veil", label: "Veil", hint: "Cinematic gradient", engine: "webgl" },
  { id: "dots", label: "Dots", hint: "Sparse dots", engine: "canvas" },
  { id: "lines", label: "Lines", hint: "Neon beams", engine: "webgl" },
  { id: "grain", label: "Grain", hint: "Film grain", engine: "webgl" },
  { id: "glitch", label: "Glitch", hint: "Matrix code", engine: "canvas" },
  { id: "rays", label: "Rays", hint: "Volumetric light", engine: "webgl" },
  { id: "pixels", label: "Pixels", hint: "Isolated clusters", engine: "canvas" },
  { id: "mesh", label: "Mesh", hint: "Inward concentric", engine: "canvas" },
  { id: "silk", label: "Silk", hint: "Flowing fabric", engine: "webgl" },
];

export const PATTERN_BY_ID: Record<string, PatternMeta> = Object.fromEntries(
  PATTERNS.map((p) => [p.id, p]),
);

export type PatternSettings = {
  intensity?: number; // 0-100
  opacity?: number; // 0-100
  blur?: number; // 0-40 (px)
  overlay?: string; // hex
  overlay_strength?: number; // 0-100
  image_url?: string; // for custom_photo
  parallax?: boolean;
};

export const DEFAULT_SETTINGS: PatternSettings = {
  intensity: 60,
  opacity: 70,
  blur: 0,
  overlay: "#000000",
  overlay_strength: 0,
  parallax: false,
};

// Curated palette of accent colors - 15 swatches that pair with a color
// picker in the UI to fill exactly two rows of 8 cells.
export const ACCENT_PALETTE: { id: string; label: string; hex: string }[] = [
  { id: "ink", label: "Ink", hex: "#0a0a0a" },
  { id: "slate", label: "Slate", hex: "#475569" },
  { id: "blue", label: "Blue", hex: "#3b82f6" },
  { id: "sky", label: "Sky", hex: "#0ea5e9" },
  { id: "cyan", label: "Cyan", hex: "#06b6d4" },
  { id: "teal", label: "Teal", hex: "#14b8a6" },
  { id: "emerald", label: "Emerald", hex: "#10b981" },
  { id: "lime", label: "Lime", hex: "#84cc16" },
  { id: "amber", label: "Amber", hex: "#f59e0b" },
  { id: "orange", label: "Orange", hex: "#f97316" },
  { id: "rose", label: "Rose", hex: "#f43f5e" },
  { id: "pink", label: "Pink", hex: "#ec4899" },
  { id: "fuchsia", label: "Fuchsia", hex: "#d946ef" },
  { id: "violet", label: "Violet", hex: "#8b5cf6" },
  { id: "indigo", label: "Indigo", hex: "#6366f1" },
];
