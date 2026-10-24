import type { OnboardingSession } from "./session.server";

type Outcome = {
  event: "brain_draft_succeeded" | "brain_draft_failed";
  properties: Record<string, string | number | boolean | null>;
};

/**
 * Turns a preparation job transition into one analytics event. Only a running or queued job
 * that finishes counts, so reloading a finished session does not double count.
 */
export function brainDraftOutcome(
  previousJobStatus: string | null,
  session: Pick<OnboardingSession, "jobStatus" | "candidates" | "generationCount">,
  platform: string,
): Outcome | null {
  if (previousJobStatus !== "queued" && previousJobStatus !== "running") return null;
  if (session.jobStatus !== "ready" && session.jobStatus !== "failed") return null;
  const candidates = session.candidates;
  const base = {
    platform,
    generation: session.generationCount,
    brain_chapters: candidates?.brain.length ?? 0,
  };
  if (session.jobStatus === "ready" && candidates?.drafts.length && !candidates.warning)
    return {
      event: "brain_draft_succeeded",
      properties: { ...base, drafts: candidates.drafts.length },
    };
  return {
    event: "brain_draft_failed",
    properties: {
      ...base,
      reason:
        candidates?.warningReason ?? (session.jobStatus === "failed" ? "job_failed" : "unknown"),
      job_status: session.jobStatus,
      starter_kept: Boolean(candidates?.drafts.length),
    },
  };
}
