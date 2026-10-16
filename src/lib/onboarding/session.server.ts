/* eslint-disable @typescript-eslint/no-explicit-any -- Paired migration owns these private tables. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  onboardingBriefSchema,
  onboardingCandidatesSchema,
  type OnboardingBrief,
  type OnboardingCandidates,
} from "./brief";

export const onboardingDb = supabaseAdmin as any;
export type OnboardingSession = {
  workspaceId: string;
  revision: number;
  step: number;
  brief: OnboardingBrief;
  candidates: OnboardingCandidates | null;
  status: "draft" | "prepared" | "applied";
  jobStatus: "idle" | "queued" | "running" | "ready" | "failed";
  jobError: string | null;
  generationCount: number;
  threadId: string | null;
};
export function sessionView(row: any): OnboardingSession {
  return {
    workspaceId: row.workspace_id,
    revision: row.revision,
    step: row.step,
    brief: onboardingBriefSchema.parse(row.brief),
    candidates: row.candidates ? onboardingCandidatesSchema.parse(row.candidates) : null,
    status: row.status,
    jobStatus: row.job_status,
    jobError: row.job_error,
    generationCount: row.generation_count,
    threadId: row.thread_id,
  };
}
export async function readOnboardingSession(workspaceId: string) {
  const { data, error } = await onboardingDb
    .from("onboarding_sessions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error("Your setup could not be loaded. Please try again.");
  return data;
}
export async function requireOnboardingPreview(workspaceId: string) {
  const session = await readOnboardingSession(workspaceId);
  if (!session || session.status === "applied")
    throw new Error("Start or resume onboarding first.");
  return session;
}
