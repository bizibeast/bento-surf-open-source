export type TrialReminderState = {
  status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export function isTrialReminderDue(trial: TrialReminderState, now = Date.now()): boolean {
  const end = Date.parse(trial.trial_ends_at ?? "");
  return (
    trial.status === "trialing" &&
    !trial.cancel_at_period_end &&
    Number.isFinite(end) &&
    end === Date.parse(trial.current_period_end ?? "") &&
    now >= end - 86_400_000 &&
    now < end
  );
}
