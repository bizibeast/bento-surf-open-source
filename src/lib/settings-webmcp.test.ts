// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  signOut: vi.fn(),
  deleteMyAccount: vi.fn(),
  getMyProfile: vi.fn(),
  setAccountTimeZone: vi.fn(),
  updateProfile: vi.fn(),
  getMyBillingOverview: vi.fn(),
  createCheckout: vi.fn(),
  changeMyPlan: vi.fn(),
  cancelMyPlanChange: vi.fn(),
  cancelMyRenewal: vi.fn(),
  acceptMyRetentionOffer: vi.fn(),
  resumeMyRenewal: vi.fn(),
  createMyBillingPortal: vi.fn(),
  getMyEmailPreferences: vi.fn(),
  updateMyEmailPreferences: vi.fn(),
  getIntegrationOverview: vi.fn(),
  getCreatorPaymentSettings: vi.fn(),
  selectCreatorPaymentProvider: vi.fn(),
  getMyCustomDomain: vi.fn(),
  connectCustomDomain: vi.fn(),
  refreshCustomDomain: vi.fn(),
  removeCustomDomain: vi.fn(),
  beginInstagramConnection: vi.fn(),
  disconnectInstagram: vi.fn(),
  beginSocialConnection: vi.fn(),
  disconnectSocialConnection: vi.fn(),
  beginGoogleCalendarConnection: vi.fn(),
  beginFathomConnection: vi.fn(),
  setDefaultBookingConnection: vi.fn(),
  disconnectBookingConnection: vi.fn(),
  beginPolarConnection: vi.fn(),
  refreshPolarConnection: vi.fn(),
  disconnectPolarConnection: vi.fn(),
  refreshStripeConnection: vi.fn(),
  disconnectStripeConnection: vi.fn(),
  refreshDodoConnection: vi.fn(),
  disconnectDodoConnection: vi.fn(),
  refreshRazorpayConnection: vi.fn(),
  disconnectRazorpayConnection: vi.fn(),
  refreshCreemConnection: vi.fn(),
  disconnectCreemConnection: vi.fn(),
  refreshPayPalConnection: vi.fn(),
  disconnectPayPalConnection: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: mocks.getUser,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      signOut: mocks.signOut,
    },
  },
}));
vi.mock("@/lib/account.functions", () => ({ deleteMyAccount: mocks.deleteMyAccount }));
vi.mock("@/lib/profile.functions", () => ({
  getMyProfile: mocks.getMyProfile,
  setAccountTimeZone: mocks.setAccountTimeZone,
  updateProfile: mocks.updateProfile,
}));
vi.mock("@/lib/billing.functions", () => ({
  getMyBillingOverview: mocks.getMyBillingOverview,
  createCheckout: mocks.createCheckout,
  changeMyPlan: mocks.changeMyPlan,
  cancelMyPlanChange: mocks.cancelMyPlanChange,
  cancelMyRenewal: mocks.cancelMyRenewal,
  acceptMyRetentionOffer: mocks.acceptMyRetentionOffer,
  resumeMyRenewal: mocks.resumeMyRenewal,
  createMyBillingPortal: mocks.createMyBillingPortal,
}));
vi.mock("@/lib/email-preferences.functions", () => ({
  getMyEmailPreferences: mocks.getMyEmailPreferences,
  updateMyEmailPreferences: mocks.updateMyEmailPreferences,
}));
vi.mock("@/lib/integrations.functions", () => ({
  getIntegrationOverview: mocks.getIntegrationOverview,
}));
vi.mock("@/lib/payment-connections.functions", () => ({
  getCreatorPaymentSettings: mocks.getCreatorPaymentSettings,
  selectCreatorPaymentProvider: mocks.selectCreatorPaymentProvider,
}));
vi.mock("@/lib/custom-domains.functions", () => ({
  getMyCustomDomain: mocks.getMyCustomDomain,
  connectCustomDomain: mocks.connectCustomDomain,
  refreshCustomDomain: mocks.refreshCustomDomain,
  removeCustomDomain: mocks.removeCustomDomain,
}));
vi.mock("@/lib/social-connections.functions", () => ({
  beginInstagramConnection: mocks.beginInstagramConnection,
  disconnectInstagram: mocks.disconnectInstagram,
}));
vi.mock("@/lib/social-oauth.functions", () => ({
  beginSocialConnection: mocks.beginSocialConnection,
  disconnectSocialConnection: mocks.disconnectSocialConnection,
}));
vi.mock("@/lib/booking.functions", () => ({
  beginGoogleCalendarConnection: mocks.beginGoogleCalendarConnection,
  beginFathomConnection: mocks.beginFathomConnection,
  setDefaultBookingConnection: mocks.setDefaultBookingConnection,
  disconnectBookingConnection: mocks.disconnectBookingConnection,
}));
vi.mock("@/integrations/polar/connection.functions", () => ({
  beginPolarConnection: mocks.beginPolarConnection,
  refreshPolarConnection: mocks.refreshPolarConnection,
  disconnectPolarConnection: mocks.disconnectPolarConnection,
}));
vi.mock("@/integrations/stripe/connection.functions", () => ({
  refreshStripeConnection: mocks.refreshStripeConnection,
  disconnectStripeConnection: mocks.disconnectStripeConnection,
}));
vi.mock("@/integrations/dodo/connection.functions", () => ({
  refreshDodoConnection: mocks.refreshDodoConnection,
  disconnectDodoConnection: mocks.disconnectDodoConnection,
}));
vi.mock("@/integrations/razorpay/connection.functions", () => ({
  refreshRazorpayConnection: mocks.refreshRazorpayConnection,
  disconnectRazorpayConnection: mocks.disconnectRazorpayConnection,
}));
vi.mock("@/integrations/creem/connection.functions", () => ({
  refreshCreemConnection: mocks.refreshCreemConnection,
  disconnectCreemConnection: mocks.disconnectCreemConnection,
}));
vi.mock("@/integrations/paypal/connection.functions", () => ({
  refreshPayPalConnection: mocks.refreshPayPalConnection,
  disconnectPayPalConnection: mocks.disconnectPayPalConnection,
}));

import { createSettingsWebMcpTools } from "./settings-webmcp";

const connectionId = "11111111-1111-4111-8111-111111111111";
const signal = () => new AbortController().signal;

function tool(
  name: string,
  refresh = vi.fn().mockResolvedValue(undefined),
  navigate = vi.fn(),
  openPaymentSetup = vi.fn(),
) {
  const found = createSettingsWebMcpTools({ refresh, navigate, openPaymentSetup }).find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return { found, refresh, navigate, openPaymentSetup };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.getUser.mockResolvedValue({
    data: { user: { email: "owner@example.com" } },
    error: null,
  });
  mocks.getMyProfile.mockResolvedValue({
    id: "private-user-id",
    username: "owner",
    display_name: "Owner",
    bio: "Public bio",
    account_timezone: "Asia/Kolkata",
    noindex: false,
    show_in_explore: true,
    access_token: "profile-secret-token",
  });
  mocks.getMyBillingOverview.mockResolvedValue({
    plan: "creator",
    status: "active",
    hasSubscription: true,
    customerId: "private-customer-id",
  });
  mocks.getMyEmailPreferences.mockResolvedValue({
    productUpdates: true,
    weeklyDigest: false,
    marketingUnsubscribed: false,
  });
  mocks.getIntegrationOverview.mockResolvedValue({
    readiness: { instagram: true },
    bookingReadiness: { google: true, fathom: true },
    socialConnections: [
      {
        id: connectionId,
        provider: "instagram",
        handle: "owner",
        displayName: "Owner",
        status: "active",
        accessToken: "social-secret-token",
      },
    ],
    calendarConnections: [
      {
        id: connectionId,
        email: "private-calendar@example.com",
        displayName: "Work calendar",
        status: "active",
        isDefault: true,
        refreshToken: "calendar-secret-token",
      },
    ],
    fathomConnections: [],
  });
  mocks.getCreatorPaymentSettings.mockResolvedValue({
    locked: false,
    feeBps: 300,
    selectedProvider: "stripe",
    recommendedProvider: "razorpay",
    connections: [
      {
        id: connectionId,
        provider: "stripe",
        accountId: "acct_private",
        onboardingStatus: "complete",
        chargesEnabled: true,
        payoutsEnabled: true,
        credentialMode: "restricted_key",
        webhookReady: true,
        secret: "payment-secret-token",
      },
    ],
    providers: [{ id: "stripe", name: "Stripe", configured: true }],
  });
  mocks.getMyCustomDomain.mockResolvedValue({
    cnameTarget: "domains.bento.surf",
    domain: {
      id: "private-domain-id",
      hostname: "links.example.com",
      status: "active",
      sslStatus: "active",
      ready: true,
      verificationRecords: [],
      cloudflareToken: "domain-secret-token",
    },
  });
  for (const mock of Object.values(mocks)) {
    if (mock.getMockName() === "vi.fn()" && !mock.getMockImplementation()) {
      mock.mockResolvedValue({ ok: true });
    }
  }
  mocks.setAccountTimeZone.mockResolvedValue({ manualTimeZone: "UTC", effectiveTimeZone: "UTC" });
  mocks.beginInstagramConnection.mockResolvedValue({ url: "https://instagram.com/oauth" });
  mocks.beginSocialConnection.mockResolvedValue({ url: "https://facebook.com/oauth" });
  mocks.beginGoogleCalendarConnection.mockResolvedValue({
    url: "https://accounts.google.com/oauth",
  });
  mocks.beginFathomConnection.mockResolvedValue({ url: "https://fathom.video/oauth" });
  mocks.beginPolarConnection.mockResolvedValue({ url: "https://polar.sh/oauth" });
  mocks.createCheckout.mockResolvedValue({ url: "https://checkout.dodopayments.com/session" });
  mocks.changeMyPlan.mockResolvedValue({ mode: "scheduled", billing: {} });
  mocks.createMyBillingPortal.mockResolvedValue({
    url: "https://billing.dodopayments.com/session",
  });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.resetPasswordForEmail.mockResolvedValue({ error: null });
});

describe("Settings WebMCP tools", () => {
  it("registers complete route-local groups with action-specific schemas", () => {
    const tools = createSettingsWebMcpTools({ refresh: vi.fn(), navigate: vi.fn() });
    expect(tools.map(({ name }) => name)).toEqual([
      "get_settings_workspace",
      "update_settings_account",
      "manage_settings_custom_domain",
      "manage_settings_social_connection",
      "manage_settings_booking_connection",
      "manage_settings_payment_connection",
      "manage_settings_billing",
      "manage_settings_security",
    ]);
    for (const candidate of tools.slice(1)) {
      expect(candidate.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        oneOf: expect.any(Array),
      });
      expect(candidate.inputSchema?.required).toEqual(expect.arrayContaining(["action"]));
      expect(candidate.annotations?.readOnlyHint).toBe(false);
      expect(candidate.description).toContain("browser confirmation");
    }
  });

  it("returns an allowlisted workspace without credentials or private connection emails", async () => {
    const { found } = tool("get_settings_workspace");
    const result = (await found.execute({}, { signal: signal() })) as {
      structuredContent: { workspace: Record<string, unknown> };
    };
    expect(result.structuredContent.workspace).toMatchObject({
      account: { email: "owner@example.com", timeZone: "Asia/Kolkata" },
      profile: { username: "owner", display_name: "Owner" },
      customDomain: { domain: { hostname: "links.example.com", ready: true } },
      payments: { selectedProvider: "stripe" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("profile-secret-token");
    expect(serialized).not.toContain("social-secret-token");
    expect(serialized).not.toContain("calendar-secret-token");
    expect(serialized).not.toContain("payment-secret-token");
    expect(serialized).not.toContain("domain-secret-token");
    expect(serialized).not.toContain("private-calendar@example.com");
    expect(serialized).not.toContain("acct_private");
    expect(serialized).not.toContain("private-customer-id");
  });

  it("caps provider projections", async () => {
    mocks.getIntegrationOverview.mockResolvedValue({
      readiness: {},
      bookingReadiness: {},
      socialConnections: Array.from({ length: 75 }, (_, index) => ({
        id: `social-${index}`,
        provider: "instagram",
        status: "active",
      })),
      calendarConnections: [],
      fathomConnections: [],
    });
    const { found } = tool("get_settings_workspace");
    const result = (await found.execute({}, { signal: signal() })) as {
      structuredContent: {
        workspace: { integrations: { socialConnections: unknown[] } };
      };
    };

    expect(result.structuredContent.workspace.integrations.socialConnections).toHaveLength(50);
  });

  it("fails closed before every Settings mutation when native confirmation is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const samples: Array<[string, Record<string, unknown>]> = [
      ["update_settings_account", { action: "set_timezone", timeZone: "UTC" }],
      ["manage_settings_custom_domain", { action: "refresh" }],
      [
        "manage_settings_social_connection",
        { action: "disconnect", provider: "instagram", connectionId },
      ],
      [
        "manage_settings_booking_connection",
        { action: "set_default", provider: "google", connectionId },
      ],
      ["manage_settings_payment_connection", { action: "refresh", provider: "stripe" }],
      ["manage_settings_billing", { action: "resume_renewal" }],
      ["manage_settings_security", { action: "send_password_reset" }],
    ];
    const refresh = vi.fn();
    for (const [name, input] of samples) {
      await expect(tool(name, refresh).found.execute(input, { signal: signal() })).rejects.toThrow(
        "did not approve",
      );
    }
    expect(window.confirm).toHaveBeenCalledTimes(samples.length);
    expect(refresh).not.toHaveBeenCalled();
    expect(mocks.setAccountTimeZone).not.toHaveBeenCalled();
    expect(mocks.refreshCustomDomain).not.toHaveBeenCalled();
    expect(mocks.disconnectInstagram).not.toHaveBeenCalled();
    expect(mocks.setDefaultBookingConnection).not.toHaveBeenCalled();
    expect(mocks.refreshStripeConnection).not.toHaveBeenCalled();
    expect(mocks.resumeMyRenewal).not.toHaveBeenCalled();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("dispatches approved account, connection, billing, and security actions", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
    const openPaymentSetup = vi.fn();
    const execute = (name: string, input: Record<string, unknown>) =>
      tool(name, refresh, navigate, openPaymentSetup).found.execute(input, { signal: signal() });

    await execute("update_settings_account", {
      action: "set_email_preferences",
      productUpdates: false,
      weeklyDigest: true,
    });
    await execute("manage_settings_custom_domain", {
      action: "connect",
      hostname: "links.example.com",
    });
    await execute("manage_settings_social_connection", {
      action: "connect",
      provider: "facebook",
    });
    await execute("manage_settings_booking_connection", {
      action: "connect",
      provider: "google",
    });
    await execute("manage_settings_payment_connection", { action: "connect_polar" });
    await execute("manage_settings_payment_connection", {
      action: "open_setup",
      provider: "stripe",
    });
    await execute("manage_settings_billing", {
      action: "start_checkout",
      plan: "creator",
      period: "yearly",
    });
    await execute("manage_settings_security", { action: "send_password_reset" });

    expect(mocks.updateMyEmailPreferences).toHaveBeenCalledWith({
      data: { productUpdates: false, weeklyDigest: true },
    });
    expect(mocks.connectCustomDomain).toHaveBeenCalledWith({
      data: { hostname: "links.example.com" },
    });
    expect(mocks.beginSocialConnection).toHaveBeenCalledWith({ data: { provider: "facebook" } });
    expect(window.sessionStorage.getItem("facebookConnectionReturnTo")).toBe(
      "/settings?section=integrations&integration=social",
    );
    expect(mocks.beginGoogleCalendarConnection).toHaveBeenCalledOnce();
    expect(mocks.beginPolarConnection).toHaveBeenCalledOnce();
    expect(openPaymentSetup).toHaveBeenCalledWith("stripe");
    expect(mocks.createCheckout).toHaveBeenCalledWith({
      data: { plan: "creator", period: "yearly", returnTo: "dashboard" },
    });
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith("owner@example.com", {
      redirectTo: "http://localhost:3000/reset-password",
    });
    expect(navigate.mock.calls.map(([destination]) => destination)).toEqual([
      "https://facebook.com/oauth",
      "https://accounts.google.com/oauth",
      "https://polar.sh/oauth",
      "https://checkout.dodopayments.com/session",
    ]);
    expect(refresh).toHaveBeenCalledTimes(6);
  });

  it("uses the existing recent-auth deletion flow and replaces the signed-out page", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const navigate = vi.fn();
    await tool("manage_settings_security", vi.fn(), navigate).found.execute(
      { action: "delete_account" },
      { signal: signal() },
    );
    expect(mocks.deleteMyAccount).toHaveBeenCalledWith({ data: { confirmation: "DELETE" } });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(navigate).toHaveBeenCalledWith("/", "replace");
  });

  it("rejects invalid or excess action input before confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(
      tool("manage_settings_billing").found.execute(
        { action: "open_billing_portal", token: "do-not-accept" },
        { signal: signal() },
      ),
    ).rejects.toThrow();
    await expect(
      tool("update_settings_account").found.execute(
        { action: "update_profile", profile: {} },
        { signal: signal() },
      ),
    ).rejects.toThrow("at least one");
    expect(confirm).not.toHaveBeenCalled();
  });
});
