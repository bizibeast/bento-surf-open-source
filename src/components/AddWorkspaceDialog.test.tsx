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
    checkoutUrl: "https://app.bento.surf/onboarding",
    workspaceId: "33333333-3333-4333-8333-333333333333",
  });
});

describe("AddWorkspaceDialog", () => {
  it("opens independent onboarding for the new profile", async () => {
    const onCheckout = vi.fn();
    render(<AddWorkspaceDialog open onOpenChange={vi.fn()} onCheckout={onCheckout} />);

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Second Studio" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "second_studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up my workspace" }));

    await waitFor(() =>
      expect(mocks.beginCheckout).toHaveBeenCalledWith({
        data: { displayName: "Second Studio", username: "second_studio" },
      }),
    );
    expect(onCheckout).toHaveBeenCalledWith("https://app.bento.surf/onboarding");
  });
});
