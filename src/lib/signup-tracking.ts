export function signupFailureReason(error: unknown): string {
  const value = error as { status?: number; message?: string; code?: string } | null;
  const message = String(value?.message ?? "").toLowerCase();
  if (value?.status === 429 || message.includes("rate limit")) return "rate_limited";
  if (message.includes("sending") && message.includes("email")) return "email_send_failed";
  if (value?.code === "weak_password" || message.includes("weak password")) return "weak_password";
  if (error instanceof TypeError || /network|failed to fetch|load failed/.test(message))
    return "network";
  return "other";
}
export function createSignupTracking(startedAt: number) {
  let sent = false;
  let leaving = false;
  let googleClicked = false;
  return {
    google() {
      googleClicked = true;
      leaving = true;
    },
    failed() {
      leaving = false;
    },
    succeeded() {
      leaving = true;
    },
    leave(
      step: "username" | "account" | "confirmation",
      emailEntered: boolean,
      passwordEntered: boolean,
      now: number,
    ) {
      if (sent || leaving) return null;
      sent = true;
      return {
        step,
        seconds_on_page: Math.max(0, Math.round((now - startedAt) / 1000)),
        email_entered: emailEntered,
        password_entered: passwordEntered,
        google_clicked: googleClicked,
      };
    },
  };
}
export function redactSignupMessage(message: string, secrets: readonly string[]): string {
  for (const secret of secrets) {
    if (!secret) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    message = message.replace(new RegExp(escaped, "gi"), "[redacted]");
  }
  return message.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[redacted]").slice(0, 160);
}
