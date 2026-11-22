import { CHECKOUT_RECOVERY_KEY, rememberCheckoutForRecovery } from "@/lib/checkout-recovery";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { captureProductEvent } from "@/lib/posthog";
import { createCheckout, getCheckoutOffer } from "@/lib/billing.functions";
import { beginCheckoutTracking, forceCheckoutReplay } from "@/lib/checkout-tracking";
import { UpgradeDialog } from "./UpgradeDialog";

vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
vi.mock("@/lib/checkout-tracking", () => ({
  beginCheckoutTracking: vi.fn(),
  forceCheckoutReplay: vi.fn(),
}));
vi.mock("@/lib/billing.functions", () => ({
  getCheckoutOffer: vi.fn(),
  createCheckout: vi.fn(),
}));
vi.mock("@/lib/safe-url", () => ({ safeNavigationHref: (url: string) => url }));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.mocked(captureProductEvent).mockClear();
  vi.mocked(beginCheckoutTracking).mockClear();
  vi.mocked(getCheckoutOffer).mockResolvedValue({
    trialEligible: true,
    active: false,
    fullyManagedCheckoutAvailable: true,
  });
  vi.mocked(createCheckout).mockResolvedValue({ url: "#checkout" } as never);
});

it("tracks the dialog funnel with source, plan and billing interval", async () => {
  render(<UpgradeDialog trigger={null} open onOpenChange={() => {}} source="dashboard_banner" />);
  expect(captureProductEvent).toHaveBeenCalledWith("upgrade_dialog_opened", {
    source: "dashboard_banner",
    feature: null,
    plan: "store",
    billing_interval: "monthly",
  });
  fireEvent.click(screen.getByRole("button", { name: "Yearly · 2 months free" }));
  const cta = await screen.findByRole("button", { name: /Start 3-day .* trial/ });
  fireEvent.click(cta);
  const expected = {
    source: "dashboard_banner",
    surface: "upgrade_dialog",
    plan: "store",
    billing_interval: "yearly",
    trial: true,
  };
  expect(captureProductEvent).toHaveBeenCalledWith("trial_cta_clicked", expected);
  await waitFor(() =>
    expect(captureProductEvent).toHaveBeenCalledWith("checkout_started", expected),
  );
  expect(createCheckout).toHaveBeenCalledWith({
    data: expect.objectContaining({ plan: "store", period: "yearly" }),
  });
  expect(forceCheckoutReplay).toHaveBeenCalled();
  expect(beginCheckoutTracking).toHaveBeenCalledWith({
    plan: "store",
    trial: true,
    surface: "upgrade_dialog",
  });
});

it("does not count a failed checkout as started", async () => {
  vi.mocked(createCheckout).mockRejectedValue(new Error("nope"));
  render(<UpgradeDialog trigger={null} open onOpenChange={() => {}} source="x" />);
  fireEvent.click(await screen.findByRole("button", { name: /Start 3-day .* trial/ }));
  await waitFor(() => expect(createCheckout).toHaveBeenCalled());
  expect(captureProductEvent).not.toHaveBeenCalledWith("checkout_started", expect.anything());
  expect(beginCheckoutTracking).not.toHaveBeenCalled();
});

const recovery = {
  plan: "creator_plus",
  period: "monthly",
  trial: true,
  surface: "onboarding_trial_step",
} as const;
it("retries the recorded checkout and tracks recovery", async () => {
  rememberCheckoutForRecovery(recovery);
  render(<UpgradeDialog trigger={null} open />);
  const retry = await screen.findByRole("button", { name: "Try checkout again" });
  const banner = screen.getByRole("status");
  expect(banner.textContent).toContain("Checkout didn't finish");
  expect(banner.textContent).toContain(
    "Pick up your Creator+ trial where you left off. UPI, cards and wallets are accepted.",
  );
  expect(banner.textContent).not.toContain(String.fromCharCode(0x2014));
  fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
  fireEvent.click(screen.getByRole("button", { name: /^Store/ }));
  fireEvent.click(retry);
  await waitFor(() =>
    expect(createCheckout).toHaveBeenCalledWith({
      data: expect.objectContaining({ plan: "creator_plus", period: "monthly" }),
    }),
  );
  expect(captureProductEvent).toHaveBeenCalledWith(
    "checkout_recovery_retry_clicked",
    expect.objectContaining({
      plan: "creator_plus",
      billing_interval: "monthly",
      surface: "upgrade_dialog",
      original_surface: "onboarding_trial_step",
    }),
  );
  expect(captureProductEvent).toHaveBeenCalledWith(
    "checkout_recovery_banner_shown",
    expect.objectContaining({ plan: "creator_plus" }),
  );
});
it("persists dismissal and tracks it", async () => {
  rememberCheckoutForRecovery(recovery);
  render(<UpgradeDialog trigger={null} open />);
  fireEvent.click(await screen.findByRole("button", { name: "Dismiss checkout reminder" }));
  expect(screen.queryByText("Checkout didn't finish")).toBeNull();
  expect(JSON.parse(localStorage.getItem(CHECKOUT_RECOVERY_KEY)!).dismissedAt).toEqual(
    expect.any(Number),
  );
  expect(captureProductEvent).toHaveBeenCalledWith(
    "checkout_recovery_banner_dismissed",
    expect.objectContaining({ plan: "creator_plus" }),
  );
});
it("hides recovery for an active offer", async () => {
  rememberCheckoutForRecovery(recovery);
  vi.mocked(getCheckoutOffer).mockResolvedValue({ active: true, trialEligible: false });
  render(<UpgradeDialog trigger={null} open />);
  await screen.findByRole("button", { name: "Choose my plan in Billing" });
  expect(screen.queryByText("Checkout didn't finish")).toBeNull();
  expect(localStorage.getItem(CHECKOUT_RECOVERY_KEY)).toBeNull();
});
