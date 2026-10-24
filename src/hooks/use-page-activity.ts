import { useEffect, useState } from "react";
import { PAGE_IDLE_AFTER_MS, type PagePollActivity } from "@/lib/page-poll";

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"] as const;

export function usePageActivity(): PagePollActivity {
  const [activity, setActivity] = useState<PagePollActivity>({
    visibility: "visible",
    idle: false,
  });

  useEffect(() => {
    let idleTimer = 0;
    const sync = (idle: boolean) => {
      const visibility = document.visibilityState === "hidden" ? "hidden" : "visible";
      setActivity((current) =>
        current.visibility === visibility && current.idle === idle ? current : { visibility, idle },
      );
    };
    const markActive = () => {
      window.clearTimeout(idleTimer);
      if (document.visibilityState === "hidden") {
        sync(true);
        return;
      }
      sync(false);
      idleTimer = window.setTimeout(() => sync(true), PAGE_IDLE_AFTER_MS);
    };
    markActive();
    for (const event of ACTIVITY_EVENTS)
      window.addEventListener(event, markActive, { passive: true });
    document.addEventListener("visibilitychange", markActive);
    return () => {
      window.clearTimeout(idleTimer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, markActive);
      document.removeEventListener("visibilitychange", markActive);
    };
  }, []);

  return activity;
}
