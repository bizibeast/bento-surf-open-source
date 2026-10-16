import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Clock3 } from "lucide-react";
import type { BillingLifecycle } from "@/lib/billing-lifecycle";

export function BillingLifecycleNotice({
  lifecycle,
  onBilling,
  onExport,
  onResume,
  onRestart,
  busy,
}: {
  lifecycle: BillingLifecycle;
  onBilling: () => void;
  onExport: () => void;
  onResume?: () => void;
  onRestart?: () => void;
  busy?: boolean;
}) {
  const reduced = useReducedMotion();
  const now = Date.now();
  const date = (value: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  if (lifecycle.reason === "paused") {
    return (
      <section
        className="mb-5 rounded-2xl border border-blue-200 bg-blue-50 p-5 sm:p-6"
        aria-label="Workspace pause status"
      >
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-900">
          <Clock3 className="size-4" /> Subscription paused
        </div>
        <h3 className="mt-3 font-ui-display text-2xl text-[#17213a]">
          Your Bento is taking a break
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-[#17213a]/70">
          Billing is frozen. Your hosted page, store, and creator tools are offline while paused.
          Your work is saved, and this pause does not start workspace deletion.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {onResume && (
            <button
              type="button"
              onClick={onResume}
              disabled={busy}
              className="rounded-xl bg-[#17213a] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Resume my plan
            </button>
          )}
          <button
            type="button"
            onClick={onExport}
            className="rounded-xl border border-[#17213a]/15 bg-white px-4 py-2.5 text-sm font-semibold text-[#17213a]"
          >
            Export my work
          </button>
        </div>
      </section>
    );
  }
  const pending = Date.parse(lifecycle.stoppedAt) > now;
  const toolsPaused = Date.parse(lifecycle.toolsStopAt) <= now;
  const publicPaused = Date.parse(lifecycle.publicStopAt) <= now;
  return (
    <motion.section
      initial={reduced ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mb-5 overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/70 p-5 sm:p-6"
      aria-label="Workspace billing status"
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-900">
        <Clock3 className="size-4" />
        Workspace access
      </div>
      <h3 className="mt-3 font-ui-display text-2xl text-[#17213a]">
        {lifecycle.deletingAt
          ? "This workspace is being deleted"
          : pending
            ? "Your plan stays active until the paid period ends"
            : toolsPaused
              ? "Your work is saved. Your tools are paused."
              : "There’s time to keep your workspace running."}
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#17213a]/70">
        {pending
          ? "Cancellation stops your tools, public page and products at the date below. You can resume renewal before then."
          : "Manage your payment to restore access. You can still review Billing and export your work during the retention period."}
      </p>
      <dl className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          [toolsPaused ? "Tools paused" : "Tools pause", lifecycle.toolsStopAt],
          [
            publicPaused ? "Page and products offline" : "Page and products go offline",
            lifecycle.publicStopAt,
          ],
          ["Workspace deletion", lifecycle.deleteAfter],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-amber-200/60 bg-white/70 p-3">
            <dt className="text-xs text-[#17213a]/60">{label}</dt>
            <dd className="mt-1 text-sm font-semibold text-[#17213a]">{date(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-[#17213a]/60">
        Only this unpaid workspace is affected. Other workspaces stay available. Your login is
        removed only if no workspaces remain.
      </p>
      {!lifecycle.deletingAt && (
        <div className="mt-4 flex flex-wrap gap-3">
          {onRestart && !pending && lifecycle.reason !== "past_due" ? (
            <button
              type="button"
              onClick={onRestart}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-[#17213a] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Restart Bento <ArrowUpRight className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onBilling}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-[#17213a] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Manage billing
              <ArrowUpRight className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onExport}
            className="rounded-xl border border-[#17213a]/15 bg-white px-4 py-2.5 text-sm font-semibold text-[#17213a]"
          >
            Export my work
          </button>
        </div>
      )}
    </motion.section>
  );
}
