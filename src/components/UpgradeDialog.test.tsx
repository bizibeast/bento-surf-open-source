import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpgradeDialog } from "./UpgradeDialog";

vi.mock("@/lib/billing.functions", () => ({ createCheckout: vi.fn() }));
vi.mock("@/lib/posthog", () => ({ captureProductEvent: vi.fn() }));
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

describe("UpgradeDialog onboarding offer", () => {
  it("shows what Free misses before allowing a new creator to continue", () => {
    const onOpenChange = vi.fn();
    render(<UpgradeDialog trigger={null} open showFreeOption onOpenChange={onOpenChange} />);

    expect(screen.getByRole("dialog")).toHaveClass("overflow-x-hidden", "overflow-y-auto");

    fireEvent.click(screen.getByRole("button", { name: "Continue for Free" }));

    expect(screen.getByRole("heading", { name: "Before you continue with Free" })).toBeVisible();
    expect(screen.getByText("Unlimited pages and blocks")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start 7-day Store trial" })).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue for Free" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps Store on email capture while offering 10 GB storage units", () => {
    render(<UpgradeDialog trigger={null} open />);

    expect(screen.queryByLabelText("25,000 contacts")).not.toBeInTheDocument();
    expect(screen.getByText("Email capture up to 500 contacts")).toBeVisible();
    expect(screen.getByLabelText("Added storage in 10 GB units")).toHaveAttribute("min", "0");
    expect(screen.getByLabelText("Added storage in 10 GB units")).toHaveAttribute("max", "100");
  });

  it("shows a visible focus ring for keyboard-focused contact tier radios", () => {
    render(<UpgradeDialog trigger={null} open />);
    fireEvent.click(screen.getByRole("button", { name: /Creator/ }));

    const radio = screen.getByLabelText("25,000 contacts");
    radio.focus();

    expect(radio).toHaveFocus();
    expect(radio.closest("label")).toHaveClass("focus-within:ring-2");
  });

  it("prices Creator contact tiers and storage before hosted checkout", async () => {
    const { createCheckout } = await import("@/lib/billing.functions");
    vi.mocked(createCheckout).mockResolvedValueOnce({
      url: "",
    });
    render(<UpgradeDialog trigger={null} open />);

    fireEvent.click(screen.getByRole("button", { name: /Creator/ }));
    expect(screen.getByText(/\$10 per 10 GB per year, up to 1 TB/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(screen.getByText(/\$1 per 10 GB per month, up to 1 TB/)).toBeVisible();
    fireEvent.click(screen.getByLabelText("25,000 contacts"));
    fireEvent.change(screen.getByLabelText("Added storage in 10 GB units"), {
      target: { value: "8" },
    });

    expect(screen.getByText(/unlimited marketing sends/i)).toBeVisible();
    expect(screen.getByText("$238/month before taxes")).toBeVisible();
    expect(screen.getByText("Dodo confirms the final tax and currency at checkout.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Start 7-day Creator trial" }));
    await waitFor(() =>
      expect(createCheckout).toHaveBeenCalledWith({
        data: {
          contactTier: 25_000,
          period: "monthly",
          plan: "creator",
          returnTo: "dashboard",
          storageUnits: 8,
        },
      }),
    );
  });
});
