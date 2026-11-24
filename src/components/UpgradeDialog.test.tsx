import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpgradeDialog } from "./UpgradeDialog";
import { getCheckoutOffer } from "@/lib/billing.functions";
vi.mock("@/lib/billing.functions", () => ({
  createCheckout: vi.fn(),
  getCheckoutOffer: vi
    .fn()
    .mockResolvedValue({ trialEligible: true, active: false, fullyManagedCheckoutAvailable: true }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useLoaderData: () => null,
  }),
}));
vi.stubGlobal(
  "IntersectionObserver",
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  },
);
describe("paid hosted plans", () => {
  it("offers monthly and yearly tiers and separates self-hosting from trial checkout", async () => {
    render(<UpgradeDialog trigger={null} open showFreeOption />);
    expect(await screen.findByRole("button", { name: "Start 3-day Store trial" })).toBeEnabled();
    expect(screen.getByText("$19")).toBeVisible();
    expect(screen.getByText("$39")).toBeVisible();
    expect(screen.getByText("$99")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Continue for Free" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yearly · 2 months free" }));
    expect(screen.getByText("$190")).toBeVisible();
    expect(screen.getByText("$390")).toBeVisible();
    expect(screen.getByText("$99")).toBeVisible();
    expect(screen.getByText(/Billed monthly/)).toBeVisible();
    expect(screen.getByText(/then \$190\/year plus applicable tax/)).toBeVisible();
    expect(screen.getByText(/Card, UPI or wallet required. \$0 today/)).toBeVisible();
    expect(screen.getByText(/after 3 full days/)).toBeVisible();
  });
  it("does not report Creator+ unavailable while the offer loads", () => {
    vi.mocked(getCheckoutOffer).mockReturnValueOnce(new Promise(() => {}));
    render(<UpgradeDialog trigger={null} open feature="brain" />);
    expect(screen.queryByText("Currently unavailable")).not.toBeInTheDocument();
  });
  it("recommends the plan that actually includes Brain", async () => {
    render(<UpgradeDialog trigger={null} open feature="brain" />);
    expect(await screen.findByRole("button", { name: "Start 3-day Creator+ trial" })).toBeEnabled();
  });
  it("does not promise another free trial to a returning subscriber", async () => {
    vi.mocked(getCheckoutOffer).mockResolvedValueOnce({ trialEligible: false, active: false });
    render(<UpgradeDialog trigger={null} open />);
    expect(await screen.findByText(/Your trial has already been used/)).toBeVisible();
    expect(screen.queryByText(/\$0 today/)).not.toBeInTheDocument();
  });
});
