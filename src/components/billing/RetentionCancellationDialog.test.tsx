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

it("explains immediate trial cancellation and does not offer to restart the ended trial", async () => {
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
  expect(
    screen.getByText(/Confirming cancellation ends your trial access immediately/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Skip and continue cancelling" }));
  expect(await screen.findByText(/Your trial ends immediately when you confirm/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirm cancellation" }));
  expect(await screen.findByText("Your trial has ended")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Keep my plan" })).not.toBeInTheDocument();
});
