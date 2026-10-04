import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ beginCheckout: vi.fn() }));

vi.mock("@/lib/billing.functions", () => ({
  beginAdditionalWorkspaceCheckout: mocks.beginCheckout,
}));

import { AddWorkspaceDialog } from "./AddWorkspaceDialog";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.beginCheckout.mockResolvedValue({
    checkoutUrl: "https://checkout.dodopayments.com/workspace",
    workspaceId: "33333333-3333-4333-8333-333333333333",
  });
});

describe("AddWorkspaceDialog", () => {
  it("starts a separate subscription checkout for the new profile", async () => {
    const onCheckout = vi.fn();
    render(<AddWorkspaceDialog open onOpenChange={vi.fn()} onCheckout={onCheckout} />);

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Second Studio" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "second_studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));

    await waitFor(() =>
      expect(mocks.beginCheckout).toHaveBeenCalledWith({
        data: { displayName: "Second Studio", username: "second_studio" },
      }),
    );
    expect(onCheckout).toHaveBeenCalledWith("https://checkout.dodopayments.com/workspace");
  });
});
