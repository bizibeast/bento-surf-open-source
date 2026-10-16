import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown, Check, ChevronDown, Compass, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { appGuideForLocation, type AppGuide } from "@/lib/onboarding/apps";
import { getAppGuide, setAppGuideDismissed } from "@/lib/onboarding/apps.functions";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { captureProductEvent } from "@/lib/posthog";
import { motionTokens } from "@/lib/motion";
export function AppSetupGuide({ workspaceId }: { workspaceId?: string }) {
  const location = useRouterState({ select: (state) => state.location });
  const app = appGuideForLocation(location.pathname, location.search);
  return app && workspaceId ? (
    <Guide key={`${workspaceId}:${app.id}`} app={app} workspaceId={workspaceId} />
  ) : null;
}
function Guide({ app, workspaceId }: { app: AppGuide; workspaceId: string }) {
  const reduced = useReducedMotion();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const query = useQuery({
    queryKey: ["app-setup", workspaceId, app.id],
    queryFn: () => getAppGuide({ data: { appId: app.id } }),
    staleTime: (query) => (query.state.data?.complete ? Infinity : 15000),
    refetchOnWindowFocus: true,
  });
  const open = expanded ?? query.data?.showInitially ?? false;
  const complete = app.steps.filter((step) => query.data?.readiness[step.proof]).length;
  useEffect(() => {
    if (query.data?.complete)
      captureProductEvent("app_setup_complete", { app_id: app.id, flow_version: 1 });
  }, [app.id, query.data?.complete]);
  async function toggle(value: boolean) {
    setExpanded(value);
    captureProductEvent(value ? "app_setup_resumed" : "app_setup_skipped", {
      app_id: app.id,
      flow_version: 1,
    });
    try {
      await setAppGuideDismissed({ data: { appId: app.id, dismissed: !value } });
    } catch {
      toast.error("Your guide preference could not be saved.");
    }
  }
  // Completed onboarding is a milestone, not a permanent banner. Avoid a
  // loading flash on every app visit while its saved progress is checked.
  if (query.isPending || query.data?.complete) return null;

  return (
    <section
      aria-label={`${app.name} setup guide`}
      className="app-setup-guide mx-4 mt-4 shrink-0 overflow-hidden rounded-2xl border border-primary/15 bg-card shadow-sm sm:mx-6"
    >
      <button
        onClick={() => void toggle(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        <span className="rounded-lg bg-primary/10 p-2 text-primary">
          {complete === 3 ? <Check className="size-4" /> : <Compass className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {complete === 3
              ? `${app.name}: your first result is ready`
              : `Get started with ${app.name}`}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{app.benefit}</span>
        </span>
        <span className="hidden text-xs text-muted-foreground sm:block">
          {query.data ? `${complete}/3 ready` : "Setup guide"}
        </span>
        <ChevronDown
          className={`size-4 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              duration: reduced ? 0 : motionTokens.duration.normal,
              ease: motionTokens.easing.smooth,
            }}
          >
            <div className="border-t border-border p-4 sm:p-5">
              {query.data?.context.audience && (
                <p className="mb-4 text-xs leading-5 text-muted-foreground">
                  Built around your audience:{" "}
                  <span className="font-medium text-foreground">{query.data.context.audience}</span>
                  . Your saved context stays in this workspace.
                </p>
              )}
              {query.isPending ? (
                <p role="status" className="flex gap-2 text-sm">
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                  Checking what’s already ready…
                </p>
              ) : query.error ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {query.error.message}
                </p>
              ) : !query.data?.allowed && app.entitlement ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    This app needs an eligible plan. Your work stays saved.
                  </p>
                  <UpgradeDialog feature={app.entitlement} />
                </div>
              ) : (
                <ol className="grid gap-4 md:grid-cols-3">
                  {app.steps.map((step, index) => (
                    <li
                      key={step.proof + index}
                      className={`rounded-xl border p-4 ${query.data?.readiness[step.proof] ? "border-emerald-500/20 bg-emerald-500/5" : "border-border bg-muted/20"}`}
                    >
                      <div className="mb-3 flex items-center gap-2">
                        <span
                          className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${query.data?.readiness[step.proof] ? "bg-emerald-600 text-white" : "bg-primary/10 text-primary"}`}
                        >
                          {query.data?.readiness[step.proof] ? (
                            <Check className="size-3.5" />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <h3 className="text-sm font-semibold">{step.title}</h3>
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">{step.instruction}</p>
                      <p className="mt-3 text-[11px] font-medium text-muted-foreground">
                        {query.data?.readiness[step.proof]
                          ? "Found in your workspace"
                          : "Your next step"}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  onClick={() => void toggle(false)}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
                >
                  Use {app.name} below <ArrowDown className="size-3.5" />
                </button>
                <button
                  onClick={() => void query.refetch()}
                  disabled={query.isFetching}
                  className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs transition-colors hover:bg-muted"
                >
                  <RefreshCw
                    className={`size-3.5 ${query.isFetching ? "motion-safe:animate-spin" : ""}`}
                  />
                  Check my progress
                </button>
                <span className="text-xs text-muted-foreground">
                  You can reopen this guide anytime.
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
