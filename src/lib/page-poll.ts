export const PAGE_IDLE_AFTER_MS = 2 * 60_000;
export const IDLE_POLL_MS = 5 * 60_000;
export const LIVE_PUBLISH_POLL_MS = 3_000;
export const SCHEDULER_POLL_MS = 60_000;
export const WAITING_PUBLISH_POLL_MS = 15_000;

export type PagePollActivity = {
  visibility: "visible" | "hidden";
  idle: boolean;
};

/** Hidden tabs stop. Visible idle tabs use a slow interval. Active tabs keep `activeMs`. */
export function pagePollInterval(
  activeMs: number | false,
  activity: PagePollActivity,
  options?: { idleMs?: number | false },
): number | false {
  if (activity.visibility === "hidden") return false;
  if (activity.idle) return options?.idleMs ?? IDLE_POLL_MS;
  return activeMs;
}

const LIVE_TARGET_STATUSES = new Set(["queued", "publishing", "processing", "outcome_unknown"]);
const WAITING_TARGET_STATUSES = new Set(["pending", "retrying"]);

export type SchedulerPollPost = {
  status: string;
  targets?: ReadonlyArray<{ status: string; nextAttemptAt?: string | null }>;
};

/**
 * Live provider work stays on a short interval. A retry or pending target whose
 * next attempt is still in the future does not.
 */
export function schedulerPollInterval(
  posts: readonly SchedulerPollPost[] | undefined,
  activity: PagePollActivity,
  now = Date.now(),
): number | false {
  let live = false;
  let dueSoon = false;
  for (const post of posts ?? []) {
    if (post.status !== "publishing") continue;
    const targets = post.targets ?? [];
    if (targets.length === 0) {
      live = true;
      continue;
    }
    for (const target of targets) {
      if (LIVE_TARGET_STATUSES.has(target.status)) {
        live = true;
        continue;
      }
      if (!WAITING_TARGET_STATUSES.has(target.status)) continue;
      const at = Date.parse(target.nextAttemptAt ?? "");
      const remaining = Number.isFinite(at) ? at - now : 0;
      if (remaining <= SCHEDULER_POLL_MS) dueSoon = true;
    }
  }
  const activeMs = live
    ? LIVE_PUBLISH_POLL_MS
    : dueSoon
      ? WAITING_PUBLISH_POLL_MS
      : SCHEDULER_POLL_MS;
  return pagePollInterval(activeMs, activity, {
    idleMs: live ? SCHEDULER_POLL_MS : IDLE_POLL_MS,
  });
}
