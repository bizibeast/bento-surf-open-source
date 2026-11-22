import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { captureProductEvent, captureProductException } from "@/lib/posthog";
import { OnboardingErrorScreen } from "./OnboardingErrorScreen";
vi.mock("@/lib/posthog", () => ({
  captureProductEvent: vi.fn(),
  captureProductException: vi.fn(),
}));
it("reports once and offers saved-answer recovery without a home exit", () => {
  const error = new Error("x".repeat(200));
  const props = { error, reset: vi.fn() };
  const { rerender } = render(<OnboardingErrorScreen {...props} />);
  rerender(<OnboardingErrorScreen {...props} />);
  expect(screen.getByText("Your setup hit a snag")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(captureProductException).toHaveBeenCalledTimes(1);
  expect(captureProductEvent).toHaveBeenCalledWith(
    "onboarding_crashed",
    expect.objectContaining({ message: "x".repeat(160), auto_reload: false }),
  );
});
it("guards repeated DOM crash reloads for thirty seconds", () => {
  sessionStorage.setItem("onboarding-dom-reload-at", String(Date.now()));
  render(
    <OnboardingErrorScreen
      error={new DOMException("insertBefore: not a child", "NotFoundError")}
      reset={vi.fn()}
    />,
  );
  expect(captureProductEvent).toHaveBeenLastCalledWith(
    "onboarding_crashed",
    expect.objectContaining({ auto_reload: false }),
  );
});
