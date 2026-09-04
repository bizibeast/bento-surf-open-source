import { useEffect, useRef } from "react";
import { PATTERN_BY_ID, type PatternId, type PatternSettings } from "@/lib/patterns/registry";
import { makeShaderRunner, hexToRgb } from "./shader-runner";
import { SHADERS } from "./shaders";
import { CANVAS_DRAWERS, type CanvasCtx, type CanvasStore } from "./canvas-drawers";
import { safeMediaUrl } from "@/lib/safe-url";

type Props = {
  pattern: PatternId;
  settings?: PatternSettings;
  accentHex: string;
  theme: "light" | "dark";
  /** When false, suspends all animation (e.g. when not visible). */
  active?: boolean;
};

export function PatternBackdrop({ pattern, settings, accentHex, theme, active = true }: Props) {
  const meta = PATTERN_BY_ID[pattern];
  const s: PatternSettings = {
    intensity: 60,
    opacity: 70,
    blur: 0,
    overlay: "#000000",
    overlay_strength: 0,
    ...settings,
  };
  const clamp = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  const intensity = clamp(s.intensity, 0, 100, 60) / 100;
  const opacity = clamp(s.opacity, 0, 100, 70) / 100;
  const blurPx = clamp(s.blur, 0, 40, 0);
  const overlay =
    typeof s.overlay === "string" && /^#[0-9a-f]{6}$/i.test(s.overlay) ? s.overlay : "#000000";
  const overlayStrength = clamp(s.overlay_strength, 0, 100, 0);
  const imageUrl = safeMediaUrl(s.image_url);

  if (!meta || meta.engine === "none") return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ opacity, filter: blurPx ? `blur(${blurPx}px)` : undefined }}
    >
      {meta.engine === "photo" && imageUrl && (
        <PhotoPattern url={imageUrl} parallax={!!s.parallax} active={active} />
      )}
      {meta.engine === "css" && pattern === "striped" && (
        <StripedCss accent={accentHex} intensity={intensity} />
      )}
      {meta.engine === "canvas" && active && (
        <CanvasPattern pattern={pattern} accent={accentHex} intensity={intensity} theme={theme} />
      )}
      {meta.engine === "webgl" && active && (
        <WebglPattern pattern={pattern} accent={accentHex} intensity={intensity} theme={theme} />
      )}
      {overlayStrength > 0 && (
        <div
          className="absolute inset-0"
          style={{ background: overlay, opacity: overlayStrength / 100 }}
        />
      )}
    </div>
  );
}

function PhotoPattern({
  url,
  parallax,
  active,
}: {
  url: string;
  parallax: boolean;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!parallax || !active) return;
    const onMove = (e: MouseEvent) => {
      if (!ref.current) return;
      const x = (e.clientX / window.innerWidth - 0.5) * 16;
      const y = (e.clientY / window.innerHeight - 0.5) * 16;
      ref.current.style.transform = `translate3d(${x}px,${y}px,0) scale(1.05)`;
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [parallax, active]);
  return (
    <div
      ref={ref}
      className="absolute inset-0 transition-transform duration-300 ease-out"
      style={{
        backgroundImage: `url("${url.replaceAll('"', "%22")}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        transform: parallax ? "scale(1.05)" : undefined,
      }}
    />
  );
}

function StripedCss({ accent, intensity }: { accent: string; intensity: number }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        backgroundImage: `repeating-linear-gradient(45deg, ${accent}26 0px, ${accent}26 2px, transparent 2px, transparent 16px)`,
        animation: `striped-slide ${Math.max(6, 30 - intensity * 24)}s linear infinite`,
      }}
    >
      <style>{`@keyframes striped-slide { from { background-position: 0 0; } to { background-position: 64px 64px; } }`}</style>
    </div>
  );
}

function CanvasPattern({
  pattern,
  accent,
  intensity,
  theme,
}: {
  pattern: PatternId;
  accent: string;
  intensity: number;
  theme: "light" | "dark";
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{ accent: string; intensity: number; theme: "light" | "dark" }>({
    accent,
    intensity,
    theme,
  });
  stateRef.current = { accent, intensity, theme };
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const drawer = CANVAS_DRAWERS[pattern];
    if (!drawer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = canvas.parentElement!.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * dpr);
      canvas.height = Math.max(1, r.height * dpr);
      canvas.style.width = r.width + "px";
      canvas.style.height = r.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cctx.width = r.width;
      cctx.height = r.height;
    };
    const store: CanvasStore = {};
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mouse = { x: -9999, y: -9999, vx: 0, vy: 0, down: false };
    const events: { clicks: { x: number; y: number; t: number }[] } = { clicks: [] };
    const cctx: CanvasCtx = {
      canvas,
      ctx,
      width: 0,
      height: 0,
      dpr,
      time: 0,
      intensity: stateRef.current.intensity,
      color: stateRef.current.accent,
      theme: stateRef.current.theme,
      mouse,
      events,
    };
    resize();
    drawer.init?.(cctx, store);
    const ro = new ResizeObserver(() => {
      resize();
      drawer.init?.(cctx, store);
    });
    ro.observe(canvas.parentElement!);
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const nx = e.clientX - r.left,
        ny = e.clientY - r.top;
      mouse.vx = nx - mouse.x;
      mouse.vy = ny - mouse.y;
      mouse.x = nx;
      mouse.y = ny;
    };
    const onClick = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      events.clicks.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("click", onClick);

    let raf = 0;
    const start = performance.now();
    const tick = () => {
      if (document.hidden) {
        raf = requestAnimationFrame(tick);
        return;
      }
      cctx.time = (performance.now() - start) / 1000;
      cctx.intensity = reduced
        ? Math.min(stateRef.current.intensity, 0.2)
        : stateRef.current.intensity;
      cctx.color = stateRef.current.accent;
      cctx.theme = stateRef.current.theme;
      drawer.draw(cctx, store);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("click", onClick);
    };
  }, [pattern]);
  return <canvas ref={ref} className="absolute inset-0 size-full" />;
}

function WebglPattern({
  pattern,
  accent,
  intensity,
  theme,
}: {
  pattern: PatternId;
  accent: string;
  intensity: number;
  theme: "light" | "dark";
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const runnerRef = useRef<ReturnType<typeof makeShaderRunner>>(null);
  const stateRef = useRef({ accent, intensity, theme });
  stateRef.current = { accent, intensity, theme };
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const frag = SHADERS[pattern];
    if (!frag) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const resize = () => {
      const r = canvas.parentElement!.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * dpr);
      canvas.height = Math.max(1, r.height * dpr);
      canvas.style.width = r.width + "px";
      canvas.style.height = r.height + "px";
    };
    resize();
    const runner = makeShaderRunner(canvas, frag, {
      color: hexToRgb(stateRef.current.accent),
      intensity: stateRef.current.intensity,
      theme: stateRef.current.theme === "dark" ? 1 : 0,
    });
    if (!runner) return;
    runnerRef.current = runner;
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      runner.state.u_mouse = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      runner.destroy();
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
    };
  }, [pattern]);
  useEffect(() => {
    const r = runnerRef.current;
    if (!r) return;
    r.state.u_color = hexToRgb(accent);
    r.state.u_intensity = intensity;
    r.state.u_theme = theme === "dark" ? 1 : 0;
  }, [accent, intensity, theme]);
  return <canvas ref={ref} className="absolute inset-0 size-full" />;
}
