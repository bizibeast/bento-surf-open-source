/** Shared Store-style chrome for micro-apps (Store, Calendar, Scheduler, Auto-DM, Community). */
export const micro = {
  shell: "min-h-screen bg-[#f7f8fc] text-[#17213a]",
  main: "relative mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6",
  btnPrimary:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-[#3478f6] px-3.5 py-2.5 text-sm font-semibold text-white shadow-[0_12px_30px_-18px_rgba(52,120,246,0.9)] transition hover:-translate-y-0.5 hover:bg-[#2168e5] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0",
  btnPrimaryCompact:
    "inline-flex items-center gap-2 rounded-lg bg-[#3478f6] px-3 py-2 text-xs font-semibold text-white shadow-[0_12px_30px_-18px_rgba(52,120,246,0.9)] transition hover:-translate-y-0.5 hover:bg-[#2168e5] sm:px-3.5 sm:text-sm",
  btnInk:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-[#17213a] px-4 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#263252] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0",
  btnSoft:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-[#f2f5fb] px-3.5 py-2.5 text-sm font-semibold text-[#17213a] transition hover:-translate-y-0.5 hover:bg-[#e8eef9] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0",
  btnOutline:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-black/[0.08] bg-white px-3.5 py-2.5 text-sm font-semibold text-[#17213a] shadow-sm transition hover:-translate-y-0.5 hover:bg-[#f7f8fc]",
  panel:
    "overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_28px_70px_-48px_rgba(23,33,58,0.45)]",
  panelPad: "p-4",
  card: "overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_24px_60px_-44px_rgba(23,33,58,0.5)]",
  eyebrow: "text-[11px] font-semibold uppercase tracking-[0.16em] text-[#3478f6]",
  eyebrowMuted: "text-[10px] font-semibold uppercase tracking-[0.16em] text-[#17213a]/40",
  muted: "text-sm leading-6 text-[#17213a]/52",
  mutedXs: "text-xs leading-5 text-[#17213a]/55",
  bannerInfo: "rounded-xl border border-[#3478f6]/18 bg-[#dfeaff] p-3 text-[#17213a]",
  bannerWarn: "rounded-xl border border-[#f2b84b]/28 bg-[#fff8e8] p-3 text-[#17213a]",
  iconWell: "flex items-center justify-center rounded-lg bg-[#dceaff] text-[#3478f6]",
  iconWellMint: "flex items-center justify-center rounded-lg bg-[#e7f7ee] text-[#197a4d]",
  iconWellLavender: "flex items-center justify-center rounded-lg bg-[#ece7ff] text-[#5b4bc9]",
  iconWellAmber: "flex items-center justify-center rounded-lg bg-[#fff1d6] text-[#b7790b]",
  soft: "rounded-xl bg-[#f2f5fb]",
  softBlue: "rounded-xl bg-[#eef5ff]",
  empty: "rounded-2xl border border-dashed border-[#3478f6]/30 bg-white p-7 text-center shadow-sm",
  stat: "rounded-xl border border-black/[0.06] bg-white p-4 shadow-sm",
  input:
    "w-full rounded-lg border border-black/[0.08] bg-[#f8faff] px-3.5 py-2.5 text-sm text-[#17213a] outline-none transition focus:border-[#3478f6]/45 focus:bg-white",
} as const;
