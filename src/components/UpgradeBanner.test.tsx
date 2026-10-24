import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { captureProductEvent } from "@/lib/posthog";
import { UpgradeBanner } from "./UpgradeBanner";

vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
vi.mock("@/components/UpgradeDialog", () => ({
  UpgradeDialog: ({ open, source }: { open: boolean; source: string }) =>
    open ? <div role="dialog">upgrade:{source}</div> : null,
}));
beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(captureProductEvent).mockClear();
});

it("shows free workspaces a dismissible banner that opens the upgrade flow", () => {
  render(<UpgradeBanner profileId="p1" planId="free" />);
  expect(screen.getByTestId("upgrade-banner")).toBeVisible();
  expect(screen.getByText(/No charge if you cancel before the trial ends/)).toBeVisible();
  // Plan-honest: AI features are named as Creator Plus only, never promised by the trial.
  expect(
    screen.getByText(/Brain and AI drafting are included with Creator Plus only/),
  ).toBeVisible();
  expect(screen.getByTestId("upgrade-banner").textContent).not.toMatch(/[\u2013\u2014]/);
  expect(screen.getByTestId("upgrade-banner").textContent).not.toMatch(/\u2014|keep access/i);
  expect(captureProductEvent).toHaveBeenCalledWith("upgrade_banner_viewed", {
    surface: "dashboard_banner",
  });
  fireEvent.click(screen.getByRole("button", { name: /See plans/ }));
  expect(screen.getByRole("dialog")).toHaveTextContent("upgrade:dashboard_banner");
});

it("remembers dismissal across mounts", () => {
  const { unmount } = render(<UpgradeBanner profileId="p1" planId="free" />);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByTestId("upgrade-banner")).not.toBeInTheDocument();
  expect(captureProductEvent).toHaveBeenCalledWith("upgrade_banner_dismissed", {
    surface: "dashboard_banner",
  });
  unmount();
  render(<UpgradeBanner profileId="p1" planId="free" />);
  expect(screen.queryByTestId("upgrade-banner")).not.toBeInTheDocument();
});

it("never shows to paid or trialing workspaces", () => {
  for (const planId of ["store", "creator", "creator_plus"]) {
    const { unmount } = render(<UpgradeBanner profileId="p1" planId={planId} />);
    expect(screen.queryByTestId("upgrade-banner")).not.toBeInTheDocument();
    unmount();
  }
});
