import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetentionCancellationDialog } from "./RetentionCancellationDialog";
import { cancelMyRenewal, resumeMyRenewal, type MyBillingOverview } from "@/lib/billing.functions";
import { getMyCancellationImpact, startMyCancellation } from "@/lib/cancellation.functions";

const mocks = vi.hoisted(() => ({ invalidateQueries: vi.fn(async () => undefined) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    onClick?: () => void;
  }) => (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/billing.functions", () => ({
  cancelMyRenewal: vi.fn(),
  changeMyPlan: vi.fn(),
  resumeMyRenewal: vi.fn(),
}));
vi.mock("@/lib/cancellation.functions", () => ({
  acceptMyRetentionDiscount: vi.fn(),
  extendMyTrial: vi.fn(),
  getMyCancellationImpact: vi.fn(),
  pauseMySubscription: vi.fn(),
  startMyCancellation: vi.fn(),
}));

const end = "2030-01-15T00:00:00.000Z";
const billing: MyBillingOverview = {
  plan: "creator",
  status: "active",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: end,
  hasSubscription: true,
  billingPeriod: "monthly",
  billingCatalog: "2026-10",
  pendingPlan: null,
  pendingPlanEffectiveAt: null,
  retentionOfferAvailable: false,
  retentionOfferExpiresAt: null,
  pausedUntil: null,
  complimentaryAccessExpiresAt: null,
  contactTierContacts: 500,
  storageAddonUnits: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startMyCancellation).mockResolvedValue({
    intentId: "10000000-0000-4000-8000-000000000001",
    firstAttempt: true,
    reason: null,
    offerType: null,
    discountPercent: null,
    activeIntegrations: 0,
    hasSocial: false,
    activeUsage: false,
    displayName: "Asha",
  });
  vi.mocked(cancelMyRenewal).mockResolvedValue({ ...billing, cancelAtPeriodEnd: true });
  vi.mocked(resumeMyRenewal).mockResolvedValue(billing);
  vi.mocked(getMyCancellationImpact).mockResolvedValue({
    publishedPages: 2,
    publishedProducts: 1,
    scheduledPosts: 3,
    activeAutoDms: 0,
  });
});

describe("cancellation dialog", () => {
  it("lets someone skip feedback and finish cancellation with a personal receipt", async () => {
    render(
      <RetentionCancellationDialog open onOpenChange={vi.fn()} plan="creator" billing={billing} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip and continue cancelling" }));
    expect(await screen.findByText("Review your cancellation")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(await screen.findByText("Thank you, Asha, for building with Bento")).toBeVisible();
    expect(cancelMyRenewal).toHaveBeenCalledWith({
      data: { reason: null, details: undefined, intentId: "10000000-0000-4000-8000-000000000001" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep my plan" }));
    expect(await screen.findByText("Welcome back")).toBeVisible();
    expect(resumeMyRenewal).toHaveBeenCalledOnce();
  });

  it("shows a verified workspace impact after an offer is declined", async () => {
    vi.mocked(startMyCancellation).mockResolvedValueOnce({
      intentId: "10000000-0000-4000-8000-000000000001",
      firstAttempt: true,
      reason: "break",
      offerType: "pause",
      discountPercent: null,
      activeIntegrations: 1,
      hasSocial: true,
      activeUsage: true,
      displayName: "Asha",
    });
    render(
      <RetentionCancellationDialog open onOpenChange={vi.fn()} plan="creator" billing={billing} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /I am taking a break/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Take a break from Bento")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "No thanks, continue cancelling" }));
    expect(await screen.findByText("2 visible pages")).toBeVisible();
    expect(screen.getByText("1 published product")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to cancellation" })).toBeVisible();
  });

  it("records a switcher's destination and reason without another sales step", async () => {
    render(
      <RetentionCancellationDialog open onOpenChange={vi.fn()} plan="creator" billing={billing} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /moving my business elsewhere/ }));
    fireEvent.change(screen.getByRole("combobox", { name: /Where are you moving/ }), {
      target: { value: "Shopify" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /What works better/ }), {
      target: { value: "Better storefront" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Review your cancellation")).toBeVisible();
    expect(startMyCancellation).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reason: "moving_elsewhere",
        switchDestination: "Shopify",
        switchWhy: "Better storefront",
      }),
    });
  });
});

it("warns that a trial cancel ends access immediately with no charge, then ends the trial", async () => {
  vi.mocked(cancelMyRenewal).mockResolvedValue({
    ...billing,
    plan: "free",
    status: "canceled",
    cancelAtPeriodEnd: false,
  });
  render(
    <RetentionCancellationDialog
      open
      onOpenChange={vi.fn()}
      plan="creator"
      billing={{ ...billing, status: "trialing" }}
    />,
  );
  const warning =
    "Cancelling now ends your trial immediately. You'll lose access to your plan's features right away and won't be charged.";
  expect(screen.getByRole("alert")).toHaveTextContent(warning);
  expect(screen.queryByText(/continues until|keep your trial until|Access until/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Skip and continue cancelling" }));
  expect(await screen.findByText("Review your cancellation")).toBeVisible();
  // The warning is shown again right before the creator confirms.
  expect(screen.getByText(new RegExp(`^${warning.replace(/[.?]/g, "\\$&")}`))).toBeVisible();
  expect(screen.queryByText(/keep your trial until|continues until/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  expect(await screen.findByText("Your trial has ended")).toBeVisible();
  expect(
    screen.getByText(/Your trial is cancelled and access has ended. You won't be charged./),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Keep my plan" })).not.toBeInTheDocument();
});

it("keeps paid cancellation at period end with the access date", async () => {
  render(
    <RetentionCancellationDialog open onOpenChange={vi.fn()} plan="creator" billing={billing} />,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText(/Your current access continues until/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Skip and continue cancelling" }));
  expect(await screen.findByText(/Your plan will not renew. You keep Creator until/)).toBeVisible();
  expect(screen.queryByText(/ends your trial immediately/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  expect(
    await screen.findByText(/Renewal is cancelled. Your Creator access continues until/),
  ).toBeVisible();
});
