import { useEffect, useRef } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { captureProductEvent, captureProductException } from "@/lib/posthog";
import { currentOnboardingStep } from "@/lib/onboarding/funnel-tracking";
import "./onboarding.css";

export function OnboardingErrorScreen({ error }: ErrorComponentProps) {
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    let autoReload = false;
    if (
      error instanceof DOMException &&
      error.name === "NotFoundError" &&
      /insertBefore|removeChild|not a child/i.test(error.message)
    ) {
      try {
        const key = "onboarding-dom-reload-at";
        const last = Number(sessionStorage.getItem(key) ?? 0);
        if (Date.now() - last >= 30_000) {
          sessionStorage.setItem(key, String(Date.now()));
          autoReload = true;
        }
      } catch {
        /* Storage unavailable: leave manual recovery available. */
      }
    }
    const step = currentOnboardingStep();
    captureProductException(error, { surface: "onboarding_error_boundary", ...step });
    captureProductEvent("onboarding_crashed", {
      ...step,
      error_name: error instanceof Error || error instanceof DOMException ? error.name : "Unknown",
      message: (error instanceof Error || error instanceof DOMException
        ? error.message
        : String(error)
      ).slice(0, 160),
      auto_reload: autoReload,
    });
    if (autoReload) window.location.reload();
  }, [error]);
  return (
    <main translate="no" className="onboarding notranslate ob-main">
      <div className="ob-intro">
        <h1>Your setup hit a snag</h1>
        <p>Your answers are saved. Reload to pick up where you left off.</p>
        <button className="ob-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </main>
  );
}
