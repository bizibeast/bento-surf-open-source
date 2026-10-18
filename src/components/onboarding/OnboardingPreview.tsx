import { configuredPublicOrigin } from "@/lib/application-urls";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Link2, LockKeyhole, Sparkles } from "lucide-react";
import { motionTokens } from "@/lib/motion";
import type { OnboardingBrief } from "@/lib/onboarding/brief";

export const previewThemes = {
  blue: { background: "#e9f0ff", accent: "#3478f6", surface: "#d9e6ff" },
  mint: { background: "#e8f3ea", accent: "#2d8e57", surface: "#d6eadc" },
  rose: { background: "#fff0ed", accent: "#b82f32", surface: "#f8dcd8" },
};

export function OnboardingPreview({ brief }: { brief: OnboardingBrief }) {
  const reduced = useReducedMotion();
  const theme = previewThemes[brief.style];
  return (
    <div className="relative mx-auto w-full max-w-sm">
      <motion.div
        layout={!reduced}
        className="overflow-hidden rounded-[2rem] border border-black/8 bg-white p-3 shadow-xl shadow-slate-900/5"
      >
        <div className="flex items-center justify-center gap-2 py-3 text-xs text-slate-500">
          <LockKeyhole className="size-3" />{" "}
          {new URL(configuredPublicOrigin(import.meta.env.VITE_PUBLIC_URL)).host}/
          {brief.username || "your-name"}
        </div>
        <motion.div
          animate={{ backgroundColor: theme.background }}
          transition={{ duration: reduced ? 0 : motionTokens.duration.normal }}
          className="min-h-[380px] rounded-[1.4rem] p-5 text-[#17213a]"
        >
          <motion.div
            layout={!reduced}
            className="mb-5 flex size-16 items-center justify-center overflow-hidden rounded-2xl bg-white text-2xl font-semibold"
          >
            {brief.avatarUrl ? (
              <img src={brief.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <span style={{ color: theme.accent }}>
                {brief.displayName?.[0]?.toUpperCase() || <Sparkles className="size-6" />}
              </span>
            )}
          </motion.div>
          <h2 className="break-words font-[family-name:var(--font-ui-display)] text-3xl leading-tight">
            {brief.displayName || "A home for your work"}
          </h2>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600">
            {brief.bio ||
              (brief.expertise
                ? `${brief.expertise}${brief.audience ? ` for ${brief.audience}` : ""}`
                : "Your story, your ideas, and everything you want to share.")}
          </p>
          <div className="mt-6 space-y-3">
            {brief.links.map((link) => (
              <motion.div
                key={link.url}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: motionTokens.duration.fast }}
                className="flex items-center gap-3 rounded-2xl bg-white p-4"
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: theme.surface, color: theme.accent }}
                >
                  <Link2 className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{link.title}</span>
                <ArrowUpRight className="size-4 text-slate-400" />
              </motion.div>
            ))}
            {!brief.links.length && (
              <div className="rounded-2xl bg-white/80 p-4 text-sm leading-relaxed">
                {brief.displayName
                  ? `Hi, I’m ${brief.displayName}. Welcome to my page.`
                  : "One link. A world of possibilities."}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-slate-500">
        <LockKeyhole className="size-3" /> Private preview · ready for your finishing touches
      </p>
    </div>
  );
}
