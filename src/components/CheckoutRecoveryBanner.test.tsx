import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CheckoutRecoveryBanner } from "./CheckoutRecoveryBanner";
import { captureProductEvent } from "@/lib/posthog";

vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const record = {
  plan: "store",
  period: "monthly",
  trial: false,
  surface: "upgrade_dialog",
  startedAt: Date.now(),
} as const;
it("renders exact plan copy, disables busy retry, and allows dismissal", () => {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <CheckoutRecoveryBanner
      record={record}
      busy
      onRetry={onRetry}
      onDismiss={onDismiss}
      variant="onboarding"
    />,
  );
  expect(screen.getByText("Checkout didn't finish")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Pick up your Store plan where you left off. UPI, cards and wallets are accepted.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("status").textContent).not.toContain(String.fromCharCode(0x2014));
  const retry = screen.getByRole("button", { name: "Try checkout again" });
  expect(retry).toBeDisabled();
  expect(retry.querySelector(".animate-spin")).toBeTruthy();
  fireEvent.click(retry);
  expect(onRetry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss checkout reminder" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("counts a record once per mount across rerenders", () => {
  const props = {
    record,
    busy: false,
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    variant: "dialog" as const,
  };
  const view = render(<CheckoutRecoveryBanner {...props} />);
  view.rerender(<CheckoutRecoveryBanner {...props} record={{ ...record }} busy />);
  expect(captureProductEvent).toHaveBeenCalledTimes(1);
  expect(captureProductEvent).toHaveBeenCalledWith(
    "checkout_recovery_banner_shown",
    expect.objectContaining({
      surface: "upgrade_dialog",
      plan: "store",
      minutes_since_checkout: 1,
    }),
  );
});
