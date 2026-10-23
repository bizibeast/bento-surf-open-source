import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  offer: vi.fn(),
  checkout: vi.fn(),
  settings: vi.fn(),
  billing: vi.fn(),
}));

vi.mock("./posthog", () => ({ captureProductEvent: mocks.capture }));
vi.mock("./billing.functions", () => ({
  getCheckoutOffer: mocks.offer,
  createCheckout: mocks.checkout,
  getMyBillingOverview: mocks.billing,
}));
vi.mock("./payment-connections.functions", () => ({
  getCreatorPaymentSettings: mocks.settings,
}));

import { CONNECT_PAYMENTS_BANNER_BODY } from "./plans";
import {
  followConnectPayments,
  requestConnectPayments,
  requestCurrentConnectPayments,
  STORE_PAYMENTS_CHECKOUT,
} from "./connect-payments";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.offer.mockResolvedValue({ trialEligible: true, active: false });
  mocks.checkout.mockResolvedValue({ url: "https://checkout.dodopayments.com/store-trial" });
  mocks.settings.mockResolvedValue({ locked: true });
  mocks.billing.mockResolvedValue({ plan: "free" });
});

describe("connect payments checkout", () => {
  it("keeps the banner on a 3-day trial", () => {
    expect(CONNECT_PAYMENTS_BANNER_BODY).toContain("3-day");
    expect(CONNECT_PAYMENTS_BANNER_BODY).not.toMatch(/7-day|7 day|\u2014|\u2013/);
  });

  it("opens the Store trial and records trial_checkout for a free creator", async () => {
    const result = await requestConnectPayments({ plan: "free", locked: true });
    expect(mocks.capture).toHaveBeenCalledWith("connect_payments_clicked", {
      plan: "free",
      outcome: "trial_checkout",
    });
    expect(mocks.checkout).toHaveBeenCalledWith({ data: STORE_PAYMENTS_CHECKOUT });
    expect(result).toEqual({
      outcome: "trial_checkout",
      url: "https://checkout.dodopayments.com/store-trial",
    });
  });

  it("opens paid Store checkout after the trial has been used", async () => {
    mocks.offer.mockResolvedValueOnce({ trialEligible: false, active: false });
    const result = await requestConnectPayments({ plan: "free", locked: true });
    expect(result.outcome).toBe("paid_checkout");
    expect(mocks.capture).toHaveBeenCalledWith("connect_payments_clicked", {
      plan: "free",
      outcome: "paid_checkout",
    });
    expect(mocks.checkout).toHaveBeenCalledWith({
      data: expect.objectContaining({ plan: "store", returnTo: "payments", period: "monthly" }),
    });
  });

  it("lets a creator who can connect skip checkout", async () => {
    const connect = vi.fn();
    const result = await followConnectPayments({ plan: "store", locked: false, connect });
    expect(result).toEqual({ outcome: "connect", url: null });
    expect(connect).toHaveBeenCalledOnce();
    expect(mocks.offer).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith("connect_payments_clicked", {
      plan: "store",
      outcome: "connect",
    });
  });

  it("reads the server lock so a trialing workspace connects", async () => {
    mocks.settings.mockResolvedValueOnce({ locked: false });
    mocks.billing.mockResolvedValueOnce({ plan: "store", status: "trialing" });
    await expect(requestCurrentConnectPayments()).resolves.toEqual({
      outcome: "connect",
      url: null,
    });
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledWith("connect_payments_clicked", {
      plan: "store",
      outcome: "connect",
    });
  });
});
