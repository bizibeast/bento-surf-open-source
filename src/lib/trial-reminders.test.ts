import { describe, expect, it } from "vitest";
import { isTrialReminderDue } from "./trial-reminders";
import { renderBentoEmail } from "./email-templates";

describe("trial ending reminder", () => {
  const end = "2026-10-14T12:00:00Z";
  const trial = {
    status: "trialing",
    trial_ends_at: end,
    current_period_end: end,
    cancel_at_period_end: false,
  };
  it("becomes due exactly 24 hours before billing and suppresses cancellation and expiry", () => {
    expect(isTrialReminderDue(trial, Date.parse("2026-10-13T11:59:59Z"))).toBe(false);
    expect(isTrialReminderDue(trial, Date.parse("2026-10-13T12:00:00Z"))).toBe(true);
    expect(
      isTrialReminderDue(
        { ...trial, cancel_at_period_end: true },
        Date.parse("2026-10-13T12:00:00Z"),
      ),
    ).toBe(false);
    expect(isTrialReminderDue(trial, Date.parse(end))).toBe(false);
    expect(
      isTrialReminderDue(
        { ...trial, current_period_end: "2026-10-15T12:00:00Z" },
        Date.parse("2026-10-13T12:00:00Z"),
      ),
    ).toBe(false);
  });
  it("puts the renewal details, cancellation action and feedback request in one email", () => {
    const email = renderBentoEmail({
      eventType: "trial_ending_reminder",
      category: "transactional",
      appUrl: "https://app.bento.surf",
      payload: {
        planName: "Creator",
        amount: 3900,
        currency: "USD",
        chargeDate: "14 October 2026 at 12:00 UTC",
      },
    });
    expect(email.text).toContain("$39.00");
    expect(email.text).toContain("14 October 2026");
    expect(email.text).toContain("cancel");
    expect(email.text).toContain("How has Bento been so far, and what could we improve?");
  });
  it("states the yearly renewal period in the first-charge reminder", () => {
    const email = renderBentoEmail({
      eventType: "trial_ending_reminder",
      category: "transactional",
      appUrl: "https://app.bento.surf",
      payload: {
        planName: "Creator",
        amount: 39000,
        currency: "USD",
        billingPeriod: "yearly",
        chargeDate: "14 October 2026",
      },
    });
    expect(email.text).toContain("$390.00 per year");
  });
});
