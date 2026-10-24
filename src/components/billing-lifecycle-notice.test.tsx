import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BillingLifecycleNotice } from "./billing-lifecycle-notice";
import { lifecycleDeadlines, type BillingLifecycle } from "@/lib/billing-lifecycle";

const stopped = Date.now() - 60_000;
const lifecycle: BillingLifecycle = {
  episodeId: "episode",
  subscriptionId: "sub_trial",
  reason: "canceled",
  plan: "store",
  stoppedAt: new Date(stopped).toISOString(),
  ...lifecycleDeadlines("canceled", stopped),
  deletingAt: null,
};
const handlers = { onBilling: vi.fn(), onExport: vi.fn(), onRestart: vi.fn() };

describe("workspace access notice", () => {
  it("explains a cancelled trial without unpaid-bill wording", () => {
    render(<BillingLifecycleNotice lifecycle={lifecycle} trialEnded {...handlers} />);
    expect(screen.getByRole("heading", { name: "Your trial has ended" })).toBeInTheDocument();
    expect(
      screen.getByText(
        /You cancelled your trial, so you were not charged\. .*Pick a plan to continue/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue with Store/ })).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Workspace billing status" });
    expect(section.textContent).not.toMatch(/Manage your payment|unpaid|\u2014/);
  });
  it("keeps payment wording for a paid workspace that stopped", () => {
    render(<BillingLifecycleNotice lifecycle={lifecycle} {...handlers} />);
    expect(screen.getByText(/Manage your payment to restore access/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restart Bento/ })).toBeInTheDocument();
  });
});
