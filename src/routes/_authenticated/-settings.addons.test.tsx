import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BillingAddonsCard } from "./settings";

describe("BillingAddonsCard", () => {
  it("requires confirmation before changing an existing subscription and refreshes after success", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn();
    render(
      <BillingAddonsCard
        billingPeriod="monthly"
        billingStatus="active"
        contactTier={500}
        plan="creator"
        storageUnits={0}
        updating={false}
        onUpdate={update}
        onUpdated={refresh}
      />,
    );

    fireEvent.click(screen.getByLabelText("25,000 contacts"));
    fireEvent.change(screen.getByLabelText("Added storage in 10 GB units"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update add-ons" }));

    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Confirm add-on update");

    fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ contactTier: 25_000, storageUnits: 8 }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("does not show paid contact tiers for Store", () => {
    render(
      <BillingAddonsCard
        billingPeriod="yearly"
        billingStatus="active"
        contactTier={500}
        plan="store"
        storageUnits={2}
        updating={false}
        onUpdate={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("5,000 contacts")).not.toBeInTheDocument();
    expect(screen.getByText(/Email capture up to 500 contacts/)).toBeVisible();
    expect(screen.getByText(/\$10 per 10 GB per year/)).toBeVisible();
  });

  it("shows a visible focus ring for keyboard-focused contact tier radios", () => {
    render(
      <BillingAddonsCard
        billingPeriod="monthly"
        billingStatus="active"
        contactTier={500}
        plan="creator"
        storageUnits={0}
        updating={false}
        onUpdate={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    const radio = screen.getByLabelText("25,000 contacts");
    radio.focus();

    expect(radio).toHaveFocus();
    expect(radio.closest("label")).toHaveClass("focus-within:ring-2");
  });

  it("keeps local billing unchanged when Dodo rejects an add-on update", async () => {
    const update = vi.fn().mockRejectedValue(new Error("Dodo is unavailable"));
    const refresh = vi.fn();
    render(
      <BillingAddonsCard
        billingPeriod="monthly"
        billingStatus="active"
        contactTier={500}
        plan="creator"
        storageUnits={0}
        updating={false}
        onUpdate={update}
        onUpdated={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update add-ons" }));
    await screen.findByRole("dialog", { name: "Confirm add-on update" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Dodo is unavailable"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("disables controls while an add-on update is pending", () => {
    render(
      <BillingAddonsCard
        billingPeriod="monthly"
        billingStatus="active"
        contactTier={500}
        plan="creator"
        storageUnits={0}
        updating
        onUpdate={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("25,000 contacts")).toBeDisabled();
    expect(screen.getByLabelText("Added storage in 10 GB units")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });

  it("keeps verified limits separate from a rejected draft", async () => {
    const update = vi.fn().mockRejectedValue(new Error("Dodo is unavailable"));
    render(
      <BillingAddonsCard
        billingPeriod="monthly"
        billingStatus="active"
        contactTier={500}
        plan="creator"
        storageUnits={0}
        updating={false}
        onUpdate={update}
        onUpdated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("25,000 contacts"));
    fireEvent.change(screen.getByLabelText("Added storage in 10 GB units"), {
      target: { value: "8" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update add-ons" }));
    await screen.findByRole("dialog", { name: "Confirm add-on update" });
    fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Dodo is unavailable"));
    expect(screen.getByText(/verified allowance is 500 contacts and 5 GB storage/)).toBeVisible();
    expect(screen.getByText(/Estimated add-ons: \$208\/month/)).toBeVisible();
  });

  it("locks add-ons for a past-due subscription", () => {
    const update = vi.fn();
    render(
      <BillingAddonsCard
        billingPeriod="monthly"
        billingStatus="past_due"
        contactTier={500}
        plan="creator"
        storageUnits={0}
        updating={false}
        onUpdate={update}
        onUpdated={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Add-ons can be changed after your subscription is active or trialing/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Update add-ons" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Update add-ons" }));
    expect(update).not.toHaveBeenCalled();
  });
});
