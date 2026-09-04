import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  Image as ImageIcon,
  Lock,
  Palette,
  Sparkles,
  Type,
  User,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { getMyProfile, updateProfile } from "@/lib/profile.functions";
import { uploadFile } from "@/lib/upload";
import { ALL_FONTS } from "@/lib/google-fonts";
import { isPremiumPattern, normalizePlan, planHasEntitlement } from "@/lib/plans";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { DecodedImage } from "@/components/DecodedImage";
import {
  ACCENT_PALETTE,
  DEFAULT_SETTINGS,
  PATTERNS,
  PATTERN_BY_ID,
  type PatternId,
  type PatternSettings,
} from "@/lib/patterns/registry";
import type { Database, Json } from "@/integrations/supabase/types";
import { errorMessage } from "@/lib/errors";

type SectionId = "header" | "theme" | "colors" | "patterns" | "fonts";
type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];
type MyProfile = Awaited<ReturnType<typeof getMyProfile>>;
const PROFILE_QUERY_KEY = ["my-profile"] as const;

function patternSettings(value: Json): Partial<PatternSettings> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<PatternSettings>)
    : {};
}

export function AppearancePanel() {
  const qc = useQueryClient();
  const { setTheme, theme: appTheme } = useTheme();
  const { data: profile } = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: () => getMyProfile(),
  });
  const save = useMutation({
    mutationFn: async (patch: ProfileUpdate) => updateProfile({ data: patch }),
    onError: (error) => toast.error(errorMessage(error, "Could not update appearance")),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }),
  });
  const saveFont = useMutation({
    mutationFn: async (patch: ProfileUpdate) => updateProfile({ data: patch }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: PROFILE_QUERY_KEY });
      const previous = qc.getQueryData<MyProfile>(PROFILE_QUERY_KEY);
      qc.setQueryData<MyProfile>(PROFILE_QUERY_KEY, (current) =>
        current ? ({ ...current, ...patch } as MyProfile) : current,
      );
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(PROFILE_QUERY_KEY, context.previous);
      }
      toast.error(errorMessage(error, "Could not update appearance"));
    },
    onSuccess: (updated) => {
      qc.setQueryData(PROFILE_QUERY_KEY, updated);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }),
  });
  const patternRevision = useRef(0);
  const patternSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patternSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [open, setOpen] = useState<SectionId | null>("header");
  const plan = normalizePlan(profile?.plan_id, Boolean(profile?.is_pro));
  const hasAllThemes = planHasEntitlement(plan, "allThemes");
  const hasCustomFonts = planHasEntitlement(plan, "customFonts");

  const headerMode = (profile?.header_mode as "with_photo" | "no_banner") ?? "with_photo";
  const theme = (profile?.theme as "light" | "dark") ?? (appTheme === "dark" ? "dark" : "light");
  const accent = profile?.accent_color ?? "indigo";
  const accentHex = ACCENT_PALETTE.find((a) => a.id === accent)?.hex ?? accent;
  const pattern = (profile?.pattern as PatternId) ?? "none";
  const settings: PatternSettings = {
    ...DEFAULT_SETTINGS,
    ...patternSettings(profile?.pattern_settings ?? null),
  };

  const setSetting = (patch: Partial<PatternSettings>) => {
    const cachedProfile = qc.getQueryData<MyProfile>(PROFILE_QUERY_KEY) ?? profile;
    const nextSettings: PatternSettings = {
      ...DEFAULT_SETTINGS,
      ...patternSettings(cachedProfile?.pattern_settings ?? null),
      ...patch,
    };
    const revision = ++patternRevision.current;

    // Range inputs must own the value immediately. Waiting for the network here
    // makes a controlled slider snap back to the previous server value while it
    // is being dragged, which made intensity and opacity appear non-functional.
    qc.setQueryData<MyProfile>(PROFILE_QUERY_KEY, (current) =>
      current ? ({ ...current, pattern_settings: nextSettings as Json } as MyProfile) : current,
    );

    if (patternSaveTimer.current) clearTimeout(patternSaveTimer.current);
    patternSaveTimer.current = setTimeout(() => {
      // Serialize writes as well as debouncing them. A slower, older request must
      // never arrive after a newer value and restore stale pattern settings.
      patternSaveQueue.current = patternSaveQueue.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const updated = await updateProfile({
              data: { pattern_settings: nextSettings as Json },
            });
            if (revision === patternRevision.current) {
              qc.setQueryData(PROFILE_QUERY_KEY, updated);
              await qc.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
            }
          } catch (error) {
            if (revision === patternRevision.current) {
              await qc.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
            }
            toast.error(errorMessage(error, "Could not update appearance"));
          }
        });
    }, 250);
  };

  return (
    <div
      className="w-[min(320px,calc(100vw-1rem))] rounded-[28px] bg-white p-3 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.35)]"
      style={{
        maxHeight: "calc(100dvh - 16px)",
        overflowY: "auto",
      }}
    >
      <div className="space-y-2">
        <Section id="header" icon={User} label="Header" open={open} onOpen={setOpen}>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: "no_banner", label: "No Banner", desc: "Hide profile" },
              { id: "with_photo", label: "With Photo", desc: "Show profile" },
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => save.mutate({ header_mode: opt.id })}
                className={`flex flex-col items-start gap-1 rounded-2xl border p-3 text-left transition ${
                  headerMode === opt.id
                    ? "border-neutral-900 bg-white"
                    : "border-transparent bg-neutral-50 hover:bg-white"
                }`}
              >
                <div className="flex h-12 w-full items-center justify-center rounded-lg bg-neutral-100">
                  {opt.id === "with_photo" ? (
                    <div className="size-6 rounded-full bg-neutral-400" />
                  ) : (
                    <div className="h-1 w-8 rounded bg-neutral-400" />
                  )}
                </div>
                <div className="text-xs font-medium text-neutral-900">{opt.label}</div>
                <div className="text-[10px] text-neutral-500">{opt.desc}</div>
              </button>
            ))}
          </div>
        </Section>

        <Section id="theme" icon={Sparkles} label="Theme" open={open} onOpen={setOpen}>
          <div className="flex gap-1 rounded-xl bg-neutral-100 p-1">
            {(["light", "dark"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setTheme(t);
                  save.mutate({ theme: t });
                }}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs capitalize transition ${
                  theme === t
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Section>

        <Section id="colors" icon={Palette} label="Colors" open={open} onOpen={setOpen}>
          <div className="grid grid-cols-8 gap-2">
            {ACCENT_PALETTE.map((c) => {
              const isActive = accent === c.id || accent === c.hex;
              return (
                <button
                  key={c.id}
                  title={c.label}
                  onClick={() => save.mutate({ accent_color: c.id })}
                  className={`aspect-square rounded-lg border-2 transition-transform duration-150 hover:scale-110 ${
                    isActive
                      ? "border-neutral-900 ring-2 ring-neutral-900/20"
                      : "border-white shadow-sm"
                  }`}
                  style={{ background: c.hex }}
                />
              );
            })}
            <label
              className="relative flex aspect-square cursor-pointer items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-neutral-300 hover:border-neutral-500"
              style={{
                background:
                  "conic-gradient(from 0deg, #f43f5e, #f59e0b, #84cc16, #06b6d4, #6366f1, #ec4899, #f43f5e)",
              }}
              title="Custom color"
            >
              <span className="absolute inset-1 rounded-md bg-white/85 backdrop-blur-sm" />
              <Palette className="relative size-3.5 text-neutral-700" />
              <input
                type="color"
                className="absolute inset-0 cursor-pointer opacity-0"
                value={accentHex.startsWith("#") ? accentHex : "#6366f1"}
                onChange={(e) => save.mutate({ accent_color: e.target.value })}
              />
            </label>
          </div>
        </Section>

        <Section id="patterns" icon={ImageIcon} label="Patterns" open={open} onOpen={setOpen}>
          <div className="grid grid-cols-2 gap-2">
            {PATTERNS.map((p) => {
              const isActive = pattern === p.id;
              const locked = !hasAllThemes && isPremiumPattern(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() =>
                    locked
                      ? toast.error("All themes are included with every Bento plan.")
                      : save.mutate({ pattern: p.id })
                  }
                  className={`flex items-center justify-between gap-1 rounded-xl border px-3 py-2.5 text-left text-xs font-medium transition ${
                    isActive
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-200 bg-white text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50"
                  } ${locked ? "opacity-60" : ""}`}
                  title={locked ? "Link theme" : p.hint}
                >
                  {p.label}
                  {locked && <Lock className="size-3 shrink-0 text-neutral-400" />}
                </button>
              );
            })}
          </div>

          {PATTERN_BY_ID[pattern]?.engine === "photo" && (
            <PhotoUploader
              url={settings.image_url}
              onChange={(url) => setSetting({ image_url: url || undefined })}
            />
          )}

          {pattern !== "none" && (
            <div className="space-y-2 pt-3">
              <Slider
                label="Intensity"
                value={settings.intensity ?? 60}
                onChange={(v) => setSetting({ intensity: v })}
              />
              <Slider
                label="Opacity"
                value={settings.opacity ?? 70}
                onChange={(v) => setSetting({ opacity: v })}
              />
              {PATTERN_BY_ID[pattern]?.supportsBlur && (
                <Slider
                  label="Blur"
                  value={settings.blur ?? 0}
                  onChange={(v) => setSetting({ blur: v })}
                  max={40}
                  unit="px"
                />
              )}
              {PATTERN_BY_ID[pattern]?.supportsOverlay && (
                <>
                  <Slider
                    label="Overlay"
                    value={settings.overlay_strength ?? 0}
                    onChange={(v) => setSetting({ overlay_strength: v })}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-neutral-500">Overlay color</span>
                    <input
                      type="color"
                      className="h-6 w-10 cursor-pointer rounded border border-neutral-200 bg-transparent"
                      value={settings.overlay ?? "#000000"}
                      onChange={(e) => setSetting({ overlay: e.target.value })}
                    />
                  </div>
                </>
              )}
              {PATTERN_BY_ID[pattern]?.engine === "photo" && (
                <label className="flex items-center justify-between rounded-lg px-1 py-1">
                  <span className="text-[11px] text-neutral-500">Parallax</span>
                  <input
                    type="checkbox"
                    checked={!!settings.parallax}
                    onChange={(e) => setSetting({ parallax: e.target.checked })}
                  />
                </label>
              )}
            </div>
          )}
        </Section>

        <Section id="fonts" icon={Type} label="Fonts" open={open} onOpen={setOpen}>
          {hasCustomFonts ? (
            <>
              <FontPicker
                label="Title font"
                value={profile?.secondary_font ?? ""}
                onChange={(v) => saveFont.mutate({ secondary_font: v || null })}
              />
              <FontPicker
                label="Subtitle font"
                value={profile?.primary_font ?? ""}
                onChange={(v) => saveFont.mutate({ primary_font: v || null })}
              />
            </>
          ) : (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-4 text-center">
              <Lock className="mx-auto size-4 text-neutral-400" />
              <p className="mt-2 text-xs font-medium text-neutral-700">
                Custom fonts are included with every Bento plan
              </p>
              <p className="mt-1 text-[11px] text-neutral-500">Pick from every Google font.</p>
              <div className="mt-3 flex justify-center">
                <UpgradeDialog feature="customFonts" />
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  id,
  icon: Icon,
  label,
  open,
  onOpen,
  children,
}: {
  id: SectionId;
  icon: LucideIcon;
  label: string;
  open: SectionId | null;
  onOpen: (s: SectionId | null) => void;
  children: React.ReactNode;
}) {
  const isOpen = open === id;
  return (
    <div
      className={`overflow-hidden rounded-2xl transition-colors duration-200 ${isOpen ? "bg-neutral-100" : "bg-neutral-50 hover:bg-neutral-100/70"}`}
    >
      <button
        type="button"
        onClick={() => onOpen(isOpen ? null : id)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
      >
        <Icon
          className="size-[18px] text-neutral-700 transition-transform duration-200"
          style={{ transform: isOpen ? "scale(1.05)" : "scale(1)" }}
        />
        <span className="font-sans text-[15px] font-semibold text-neutral-900">{label}</span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 px-4 pb-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  max = 100,
  unit = "%",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  max?: number;
  unit?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums">
          {Math.round(value)}
          {unit}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-neutral-200 accent-neutral-900"
      />
    </div>
  );
}

function FontPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-neutral-500">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900"
        style={value ? { fontFamily: `"${value}"` } : undefined}
      >
        <option value="">Default</option>
        {ALL_FONTS.map((f) => (
          <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
            {f}
          </option>
        ))}
      </select>
    </div>
  );
}

function PhotoUploader({
  url,
  onChange,
}: {
  url?: string;
  onChange: (url: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 rounded-xl border border-dashed border-border p-2">
      {url ? (
        <div className="relative">
          <DecodedImage src={url} alt="" className="h-24 w-full rounded-lg object-cover" />
          <button
            onClick={() => onChange(null)}
            className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <label className="flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg text-xs text-muted-foreground hover:bg-accent/30">
          <Upload className="size-4" />
          {busy ? "Uploading…" : "Upload background photo"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              try {
                const publicUrl = await uploadFile(f, "image");
                onChange(publicUrl);
              } catch (error: unknown) {
                toast.error(errorMessage(error, "Upload failed"));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      )}
    </div>
  );
}
