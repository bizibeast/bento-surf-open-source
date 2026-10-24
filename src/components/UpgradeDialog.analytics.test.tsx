import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { captureProductEvent } from "@/lib/posthog";
import { createCheckout, getCheckoutOffer } from "@/lib/billing.functions";
import { UpgradeDialog } from "./UpgradeDialog";

vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
vi.mock("@/lib/billing.functions", () => ({
  getCheckoutOffer: vi.fn(),
  createCheckout: vi.fn(),
}));
vi.mock("@/lib/safe-url", () => ({ safeNavigationHref: (url: string) => url }));

beforeEach(() => {
  vi.mocked(captureProductEvent).mockClear();
  vi.mocked(getCheckoutOffer).mockResolvedValue({ trialEligible: true, active: false });
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
});

it("does not count a failed checkout as started", async () => {
  vi.mocked(createCheckout).mockRejectedValue(new Error("nope"));
  render(<UpgradeDialog trigger={null} open onOpenChange={() => {}} source="x" />);
  fireEvent.click(await screen.findByRole("button", { name: /Start 3-day .* trial/ }));
  await waitFor(() => expect(createCheckout).toHaveBeenCalled());
  expect(captureProductEvent).not.toHaveBeenCalledWith("checkout_started", expect.anything());
});
