import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { deleteMyAccount } from "@/lib/account.functions";
import {
  cancelMyPlanChange,
  cancelMyRenewal,
  changeMyPlan,
  createCheckout,
  createMyBillingPortal,
  getMyBillingOverview,
  resumeMyRenewal,
} from "@/lib/billing.functions";
import {
  acceptMyRetentionDiscount,
  extendMyTrial,
  getMyCancellationImpact,
  pauseMySubscription,
  resumeMyPausedSubscription,
  startMyCancellation,
} from "@/lib/cancellation.functions";
import { cancellationReasonSchema as currentCancellationReasonSchema } from "@/lib/cancellation-policy";
import {
  beginFathomConnection,
  beginGoogleCalendarConnection,
  disconnectBookingConnection,
  setDefaultBookingConnection,
} from "@/lib/booking.functions";
import {
  connectCustomDomain,
  getMyCustomDomain,
  refreshCustomDomain,
  removeCustomDomain,
} from "@/lib/custom-domains.functions";
import { getMyEmailPreferences, updateMyEmailPreferences } from "@/lib/email-preferences.functions";
import { exploreCategorySchema, EXPLORE_CATEGORY_IDS } from "@/lib/explore";
import { getIntegrationOverview } from "@/lib/integrations.functions";
import {
  getCreatorPaymentSettings,
  selectCreatorPaymentProvider,
} from "@/lib/payment-connections.functions";
import { CREATOR_PAYMENT_PROVIDERS, type CreatorPaymentProvider } from "@/lib/payment-providers";
import { getMyProfile, setAccountTimeZone, updateProfile } from "@/lib/profile.functions";
import { safeNavigationHref, trustedApplicationOrigin } from "@/lib/safe-url";
import {
  FACEBOOK_CONNECTION_RETURN_TO,
  INSTAGRAM_CONNECTION_RETURN_TO,
  TWITTER_CONNECTION_RETURN_TO,
} from "@/lib/settings-integrations";
import { beginInstagramConnection, disconnectInstagram } from "@/lib/social-connections.functions";
import {
  beginSocialConnection,
  disconnectSocialConnection,
  type GenericProvider,
} from "@/lib/social-oauth.functions";
import { PUBLIC_SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social-scheduler";
import {
  detectedBrowserTimeZone,
  isValidTimeZone,
  setBrowserTimeZoneOverride,
} from "@/lib/timezones";
import { usernameSchema } from "@/lib/username";
import { requireWebMcpUserConfirmation, webMcpResult, type WebMcpTool } from "@/lib/webmcp";
import {
  disconnectCreemConnection,
  refreshCreemConnection,
} from "@/integrations/creem/connection.functions";
import {
  disconnectDodoConnection,
  refreshDodoConnection,
} from "@/integrations/dodo/connection.functions";
import {
  disconnectPayPalConnection,
  refreshPayPalConnection,
} from "@/integrations/paypal/connection.functions";
import {
  beginPolarConnection,
  disconnectPolarConnection,
  refreshPolarConnection,
} from "@/integrations/polar/connection.functions";
import {
  disconnectRazorpayConnection,
  refreshRazorpayConnection,
} from "@/integrations/razorpay/connection.functions";
import {
  disconnectStripeConnection,
  refreshStripeConnection,
} from "@/integrations/stripe/connection.functions";

type JsonProperties = Record<string, Record<string, unknown>>;
type NavigationMode = "assign" | "replace";
type ActionOutcome = {
  data?: Record<string, unknown>;
  destination?: string;
  message?: string;
  navigationMode?: NavigationMode;
  refresh?: boolean;
};

export type SettingsWebMcpOptions = {
  refresh: () => Promise<void>;
  navigate?: (destination: string, mode: NavigationMode) => void;
  openPaymentSetup?: (provider: Exclude<CreatorPaymentProvider, "polar">) => void | Promise<void>;
  openCancellationFlow?: () => void | Promise<void>;
};

const objectSchema = (
  properties: JsonProperties = {},
  required: string[] = [],
  additionalProperties = false,
) => ({ type: "object", properties, required, additionalProperties });

const actionVariants = (variants: Record<string, readonly string[]>) =>
  Object.entries(variants).map(([action, required]) => ({
    properties: { action: { const: action } },
    required: ["action", ...required],
  }));

const profileSettingsSchema = z
  .object({
    username: usernameSchema.optional(),
    noindex: z.boolean().optional(),
    show_in_explore: z.boolean().optional(),
    explore_category: exploreCategorySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Provide at least one profile setting.");

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, "Choose a valid timezone.")
  .nullable();

const settingsAccountInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update_profile"), profile: profileSettingsSchema }).strict(),
  z.object({ action: z.literal("set_timezone"), timeZone: timeZoneSchema }).strict(),
  z
    .object({
      action: z.literal("set_email_preferences"),
      productUpdates: z.boolean(),
      weeklyDigest: z.boolean(),
    })
    .strict(),
]);

const domainInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), hostname: z.string().trim().min(1).max(300) }).strict(),
  z.object({ action: z.literal("refresh") }).strict(),
  z.object({ action: z.literal("remove") }).strict(),
]);

const socialProviderSchema = z.enum(
  PUBLIC_SOCIAL_PROVIDERS as [SocialProvider, ...SocialProvider[]],
);
const socialInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), provider: socialProviderSchema }).strict(),
  z
    .object({
      action: z.literal("disconnect"),
      provider: socialProviderSchema,
      connectionId: z.string().uuid(),
    })
    .strict(),
]);

const bookingProviderSchema = z.enum(["google", "fathom"]);
const bookingInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), provider: bookingProviderSchema }).strict(),
  z
    .object({
      action: z.literal("set_default"),
      provider: bookingProviderSchema,
      connectionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("disconnect"),
      provider: bookingProviderSchema,
      connectionId: z.string().uuid(),
    })
    .strict(),
]);

const paymentProviderSchema = z.enum(CREATOR_PAYMENT_PROVIDERS);
const credentialPaymentProviderSchema = z.enum(["stripe", "dodo", "razorpay", "creem", "paypal"]);
const paymentInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect_polar") }).strict(),
  z.object({ action: z.literal("open_setup"), provider: credentialPaymentProviderSchema }).strict(),
  z.object({ action: z.literal("refresh"), provider: paymentProviderSchema }).strict(),
  z.object({ action: z.literal("select"), provider: paymentProviderSchema }).strict(),
  z.object({ action: z.literal("disconnect"), provider: paymentProviderSchema }).strict(),
]);

const cancellationReasonSchema = z.enum([
  "too_expensive",
  "missing_features",
  "switched_service",
  "unused",
  "customer_service",
  "low_quality",
  "too_complex",
  "other",
]);
const cancellationFields = {
  reason: cancellationReasonSchema,
  details: z.string().trim().max(500).optional(),
};
const billingInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start_checkout"),
      plan: z.enum(["store", "creator"]),
      period: z.enum(["monthly", "yearly"]),
    })
    .strict(),
  z.object({ action: z.literal("change_plan"), plan: z.enum(["store", "creator"]) }).strict(),
  z.object({ action: z.literal("cancel_plan_change") }).strict(),
  z.object({ action: z.literal("review_cancellation") }).strict(),
  z.object({ action: z.literal("cancel_renewal"), ...cancellationFields }).strict(),
  z.object({ action: z.literal("resume_renewal") }).strict(),
  z.object({ action: z.literal("resume_paused") }).strict(),
  z.object({ action: z.literal("open_billing_portal") }).strict(),
]);

const retentionInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      reason: currentCancellationReasonSchema.nullable(),
      details: z.string().trim().max(500).optional(),
      switchDestination: z.string().trim().max(80).optional(),
      switchWhy: z.string().trim().max(120).optional(),
    })
    .strict(),
  z.object({ action: z.literal("accept_trial_extension"), intentId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("accept_pause"),
      intentId: z.string().uuid(),
      days: z.union([z.literal(30), z.literal(60), z.literal(90)]),
    })
    .strict(),
  z.object({ action: z.literal("accept_downgrade"), intentId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("accept_discount"), intentId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("confirm_cancellation"), intentId: z.string().uuid() }).strict(),
]);

const securityInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send_password_reset") }).strict(),
  z.object({ action: z.literal("sign_out") }).strict(),
  z.object({ action: z.literal("delete_account") }).strict(),
]);

const paymentRefreshers: Record<CreatorPaymentProvider, () => Promise<unknown>> = {
  stripe: () => refreshStripeConnection(),
  dodo: () => refreshDodoConnection(),
  polar: () => refreshPolarConnection(),
  razorpay: () => refreshRazorpayConnection(),
  creem: () => refreshCreemConnection(),
  paypal: () => refreshPayPalConnection(),
};

const paymentDisconnectors: Record<CreatorPaymentProvider, () => Promise<unknown>> = {
  stripe: () => disconnectStripeConnection(),
  dodo: () => disconnectDodoConnection(),
  polar: () => disconnectPolarConnection(),
  razorpay: () => disconnectRazorpayConnection(),
  creem: () => disconnectCreemConnection(),
  paypal: () => disconnectPayPalConnection(),
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function project(value: unknown, fields: readonly string[]) {
  const source = asRecord(value);
  return Object.fromEntries(
    fields.flatMap((field) => (field in source ? [[field, source[field]]] : [])),
  );
}

function projectList(value: unknown, fields: readonly string[], limit = 50) {
  return Array.isArray(value) ? value.slice(0, limit).map((item) => project(item, fields)) : [];
}

function safeDestination(value: unknown, allowRelative = false) {
  const destination = safeNavigationHref(value, { allowRelative });
  if (!destination) throw new Error("Bento returned an invalid navigation destination.");
  return destination;
}

function defaultNavigate(destination: string, mode: NavigationMode) {
  if (typeof window === "undefined") throw new Error("This action requires a browser.");
  window.location[mode](destination);
}

function confirmedTool<T extends Record<string, unknown>>({
  name,
  title,
  description,
  inputSchema,
  parse,
  run,
  refresh,
  navigate,
}: {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse: (input: Record<string, unknown>) => T;
  run: (input: T) => Promise<ActionOutcome | void>;
  refresh: () => Promise<void>;
  navigate: (destination: string, mode: NavigationMode) => void;
}): WebMcpTool {
  return {
    name,
    title,
    description: `${description} Bento asks for browser confirmation before every action.`,
    inputSchema,
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(rawInput, { signal }) {
      signal.throwIfAborted();
      const input = parse(rawInput);
      await requireWebMcpUserConfirmation(title, input);
      signal.throwIfAborted();
      const outcome = (await run(input)) || {};
      signal.throwIfAborted();
      if (outcome.refresh !== false) await refresh();
      signal.throwIfAborted();
      if (outcome.destination) {
        navigate(outcome.destination, outcome.navigationMode || "assign");
      }
      return webMcpResult(outcome.message || `${title} completed.`, outcome.data || { ok: true });
    },
  };
}

async function optionalCustomDomain() {
  try {
    return await getMyCustomDomain();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Custom domains are disabled in the test environment."
    ) {
      return { disabled: true, cnameTarget: null, domain: null };
    }
    throw error;
  }
}

async function settingsWorkspace() {
  const [profile, billing, emailPreferences, integrations, payments, customDomain, auth] =
    await Promise.all([
      getMyProfile(),
      getMyBillingOverview(),
      getMyEmailPreferences(),
      getIntegrationOverview(),
      getCreatorPaymentSettings(),
      optionalCustomDomain(),
      supabase.auth.getUser(),
    ]);
  if (auth.error) throw new Error("Your account details could not be loaded.");

  const integrationRecord = asRecord(integrations);
  const paymentRecord = asRecord(payments);
  const domainRecord = asRecord(customDomain);
  const domain = asRecord(domainRecord.domain);

  return {
    account: {
      email: auth.data.user?.email || null,
      timeZone: asRecord(profile).account_timezone || detectedBrowserTimeZone(),
    },
    profile: project(profile, [
      "username",
      "display_name",
      "bio",
      "avatar_url",
      "cover_url",
      "theme",
      "accent_color",
      "plan_id",
      "badge_hidden",
      "calendar_page_enabled",
      "calendar_page_name",
      "social_insights_enabled",
      "store_page_enabled",
      "account_timezone",
      "noindex",
      "primary_font",
      "secondary_font",
      "header_mode",
      "pattern",
      "show_in_explore",
      "explore_category",
      "explore_review_status",
    ]),
    emailPreferences: project(emailPreferences, [
      "productUpdates",
      "weeklyDigest",
      "marketingUnsubscribed",
    ]),
    billing: project(billing, [
      "plan",
      "status",
      "cancelAtPeriodEnd",
      "currentPeriodEnd",
      "hasSubscription",
      "billingPeriod",
      "billingCatalog",
      "pendingPlan",
      "pendingPlanEffectiveAt",
      "retentionOfferAvailable",
      "retentionOfferExpiresAt",
      "pausedUntil",
      "contactTierContacts",
      "storageAddonUnits",
      "complimentaryAccessExpiresAt",
    ]),
    customDomain: {
      disabled: domainRecord.disabled === true,
      cnameTarget: domainRecord.cnameTarget || null,
      domain: Object.keys(domain).length
        ? {
            ...project(domain, [
              "hostname",
              "status",
              "sslStatus",
              "ready",
              "verificationRecords",
              "lastError",
              "lastCheckedAt",
              "createdAt",
            ]),
          }
        : null,
    },
    integrations: {
      readiness: integrationRecord.readiness || {},
      bookingReadiness: integrationRecord.bookingReadiness || {},
      socialConnections: projectList(integrationRecord.socialConnections, [
        "id",
        "provider",
        "handle",
        "displayName",
        "status",
        "canPublish",
        "canAutomate",
      ]),
      calendarConnections: projectList(integrationRecord.calendarConnections, [
        "id",
        "displayName",
        "status",
        "isDefault",
      ]),
      fathomConnections: projectList(integrationRecord.fathomConnections, [
        "id",
        "displayName",
        "status",
        "isDefault",
      ]),
    },
    payments: {
      locked: paymentRecord.locked,
      feeBps: paymentRecord.feeBps,
      selectedProvider: paymentRecord.selectedProvider || null,
      recommendedProvider: paymentRecord.recommendedProvider || null,
      connections: projectList(paymentRecord.connections, [
        "id",
        "provider",
        "onboardingStatus",
        "chargesEnabled",
        "payoutsEnabled",
        "detailsSubmitted",
        "credentialMode",
        "webhookReady",
        "connectedAt",
      ]),
      providers: projectList(paymentRecord.providers, [
        "id",
        "name",
        "configured",
        "connectionMode",
        "supportsOneTime",
        "supportsSubscriptions",
      ]),
    },
  };
}

function setSocialReturnTo(provider: SocialProvider) {
  const returnTo =
    provider === "instagram"
      ? INSTAGRAM_CONNECTION_RETURN_TO.social
      : provider === "twitter"
        ? TWITTER_CONNECTION_RETURN_TO.social
        : provider === "facebook"
          ? FACEBOOK_CONNECTION_RETURN_TO.social
          : null;
  if (!returnTo) return;
  try {
    window.sessionStorage.setItem(`${provider}ConnectionReturnTo`, returnTo);
  } catch {
    // OAuth still works when privacy settings block session storage.
  }
}

export function createSettingsWebMcpTools({
  refresh,
  navigate = defaultNavigate,
  openPaymentSetup,
  openCancellationFlow,
}: SettingsWebMcpOptions): WebMcpTool[] {
  const accountProperties = {
    action: { type: "string", enum: ["update_profile", "set_timezone", "set_email_preferences"] },
    profile: objectSchema({
      username: { type: "string", minLength: 3, maxLength: 24, pattern: "^[a-z0-9_]+$" },
      noindex: { type: "boolean" },
      show_in_explore: { type: "boolean" },
      explore_category: { type: "string", enum: [...EXPLORE_CATEGORY_IDS] },
    }),
    timeZone: { type: ["string", "null"], maxLength: 100 },
    productUpdates: { type: "boolean" },
    weeklyDigest: { type: "boolean" },
  };
  const provider = { type: "string", enum: [...PUBLIC_SOCIAL_PROVIDERS] };
  const connectionId = { type: "string", format: "uuid" };
  const paymentProvider = { type: "string", enum: [...CREATOR_PAYMENT_PROVIDERS] };
  const cancellationReason = {
    type: "string",
    enum: [
      "too_expensive",
      "missing_features",
      "switched_service",
      "unused",
      "customer_service",
      "low_quality",
      "too_complex",
      "other",
    ],
  };

  return [
    {
      name: "get_settings_workspace",
      title: "Settings workspace",
      description:
        "Loads safe account, profile, email preference, billing, custom-domain, integration, and payment status for the signed-in creator. Tokens, credentials, provider account IDs, and private connection emails are omitted.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, { signal }) {
        z.object({}).strict().parse(input);
        signal.throwIfAborted();
        const workspace = await settingsWorkspace();
        signal.throwIfAborted();
        return webMcpResult("Settings workspace loaded.", { workspace });
      },
    },
    {
      name: "get_settings_cancellation_impact",
      title: "Get cancellation impact",
      description:
        "Loads bounded counts of the published pages, products, scheduled posts, and active Auto DMs affected by ending this workspace's paid access.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      async execute(input, { signal }) {
        z.object({}).strict().parse(input);
        signal.throwIfAborted();
        const impact = await getMyCancellationImpact();
        signal.throwIfAborted();
        return webMcpResult("Loaded cancellation impact.", { impact });
      },
    },
    confirmedTool({
      name: "manage_settings_retention",
      title: "Manage cancellation and retention",
      description:
        "Starts the current reason-specific cancellation flow, accepts only the server-offered one-time response, or confirms cancellation after an intent exists. Each step is separate and browser-approved; starting does not cancel renewal.",
      inputSchema: {
        ...objectSchema(
          {
            action: {
              type: "string",
              enum: [
                "start",
                "accept_trial_extension",
                "accept_pause",
                "accept_downgrade",
                "accept_discount",
                "confirm_cancellation",
              ],
            },
            reason: {
              type: ["string", "null"],
              enum: [null, ...currentCancellationReasonSchema.options],
            },
            details: { type: "string", maxLength: 500 },
            switchDestination: { type: "string", maxLength: 80 },
            switchWhy: { type: "string", maxLength: 120 },
            intentId: { type: "string", format: "uuid" },
            days: { type: "integer", enum: [30, 60, 90] },
          },
          ["action"],
        ),
        oneOf: actionVariants({
          start: ["reason"],
          accept_trial_extension: ["intentId"],
          accept_pause: ["intentId", "days"],
          accept_downgrade: ["intentId"],
          accept_discount: ["intentId"],
          confirm_cancellation: ["intentId"],
        }),
      },
      parse: (input) => retentionInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "start") {
          const intent = await startMyCancellation({
            data: {
              reason: input.reason,
              details: input.details,
              switchDestination: input.switchDestination,
              switchWhy: input.switchWhy,
            },
          });
          return {
            data: {
              intentId: intent.intentId,
              firstAttempt: intent.firstAttempt,
              reason: intent.reason,
              offerType: intent.offerType,
              discountPercent: intent.discountPercent,
              activeIntegrations: intent.activeIntegrations,
              hasSocial: intent.hasSocial,
              activeUsage: intent.activeUsage,
            },
            message: "Cancellation options prepared. Renewal is still on.",
          };
        }
        if (input.action === "accept_trial_extension") {
          const result = await extendMyTrial({ data: { intentId: input.intentId } });
          return { data: { outcome: "trial_extended", trialEndsAt: result.trialEndsAt } };
        }
        if (input.action === "accept_pause") {
          const result = await pauseMySubscription({
            data: { intentId: input.intentId, days: input.days },
          });
          return { data: { outcome: "paused", resumeAt: result.resumeAt } };
        }
        if (input.action === "accept_downgrade") {
          const billing = await getMyBillingOverview();
          const plan = billing.plan === "creator_plus" ? "creator" : "store";
          const result = await changeMyPlan({ data: { plan, intentId: input.intentId } });
          return {
            data: {
              outcome: "downgraded",
              plan,
              effectiveAt: result.mode === "changed" ? result.billing.pendingPlanEffectiveAt : null,
            },
          };
        }
        if (input.action === "accept_discount") {
          const result = await acceptMyRetentionDiscount({ data: { intentId: input.intentId } });
          return { data: { outcome: "discounted", nextBillingDate: result.nextBillingDate } };
        }
        const billing = await cancelMyRenewal({ data: { intentId: input.intentId } });
        return {
          data: {
            outcome: "cancelled",
            cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
            accessUntil: billing.currentPeriodEnd,
          },
          message: "Renewal cancellation confirmed.",
        };
      },
      refresh,
      navigate,
    }),
    confirmedTool({
      name: "update_settings_account",
      title: "Update Settings account preferences",
      description:
        "Updates Settings profile fields, the shared account timezone, or product-email preferences.",
      inputSchema: {
        ...objectSchema(accountProperties, ["action"]),
        oneOf: actionVariants({
          update_profile: ["profile"],
          set_timezone: ["timeZone"],
          set_email_preferences: ["productUpdates", "weeklyDigest"],
        }),
      },
      parse: (input) => settingsAccountInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "update_profile") {
          await updateProfile({ data: input.profile });
        } else if (input.action === "set_timezone") {
          const result = await setAccountTimeZone({
            data: { manualTimeZone: input.timeZone, detectedTimeZone: detectedBrowserTimeZone() },
          });
          setBrowserTimeZoneOverride(result.manualTimeZone);
        } else {
          await updateMyEmailPreferences({
            data: {
              productUpdates: input.productUpdates,
              weeklyDigest: input.weeklyDigest,
            },
          });
        }
        return { data: { ok: true, action: input.action } };
      },
      refresh,
      navigate,
    }),
    confirmedTool({
      name: "manage_settings_custom_domain",
      title: "Manage Settings custom domain",
      description: "Connects, checks, or removes the creator-owned custom domain.",
      inputSchema: {
        ...objectSchema(
          {
            action: { type: "string", enum: ["connect", "refresh", "remove"] },
            hostname: { type: "string", minLength: 1, maxLength: 300 },
          },
          ["action"],
        ),
        oneOf: actionVariants({ connect: ["hostname"], refresh: [], remove: [] }),
      },
      parse: (input) => domainInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "connect") {
          await connectCustomDomain({ data: { hostname: input.hostname } });
        } else if (input.action === "refresh") {
          await refreshCustomDomain();
        } else {
          await removeCustomDomain();
        }
        return { data: { ok: true, action: input.action } };
      },
      refresh,
      navigate,
    }),
    confirmedTool({
      name: "manage_settings_social_connection",
      title: "Manage Settings social connection",
      description:
        "Starts a supported social OAuth connection or disconnects an owned connection by ID.",
      inputSchema: {
        ...objectSchema(
          {
            action: { type: "string", enum: ["connect", "disconnect"] },
            provider,
            connectionId,
          },
          ["action", "provider"],
        ),
        oneOf: actionVariants({ connect: ["provider"], disconnect: ["provider", "connectionId"] }),
      },
      parse: (input) => socialInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "disconnect") {
          if (input.provider === "instagram") {
            await disconnectInstagram({ data: { id: input.connectionId } });
          } else {
            await disconnectSocialConnection({ data: { id: input.connectionId } });
          }
          return { data: { ok: true, action: input.action, provider: input.provider } };
        }
        const result =
          input.provider === "instagram"
            ? await beginInstagramConnection({ data: { intent: "scheduler" } })
            : await beginSocialConnection({
                data: { provider: input.provider as GenericProvider },
              });
        setSocialReturnTo(input.provider);
        return {
          destination: safeDestination(result.url),
          message: `Opening ${input.provider} authorization.`,
          data: { ok: true, action: input.action, provider: input.provider },
        };
      },
      refresh,
      navigate,
    }),
    confirmedTool({
      name: "manage_settings_booking_connection",
      title: "Manage Settings meeting connection",
      description:
        "Starts Google Calendar or Fathom OAuth, selects a default account, or disconnects an owned account.",
      inputSchema: {
        ...objectSchema(
          {
            action: { type: "string", enum: ["connect", "set_default", "disconnect"] },
            provider: { type: "string", enum: ["google", "fathom"] },
            connectionId,
          },
          ["action", "provider"],
        ),
        oneOf: actionVariants({
          connect: ["provider"],
          set_default: ["provider", "connectionId"],
          disconnect: ["provider", "connectionId"],
        }),
      },
      parse: (input) => bookingInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "set_default") {
          await setDefaultBookingConnection({
            data: { type: input.provider, id: input.connectionId },
          });
        } else if (input.action === "disconnect") {
          await disconnectBookingConnection({
            data: { type: input.provider, id: input.connectionId },
          });
        } else {
          const result =
            input.provider === "google"
              ? await beginGoogleCalendarConnection()
              : await beginFathomConnection();
          return {
            destination: safeDestination(result.url),
            message: `Opening ${input.provider} authorization.`,
            data: { ok: true, action: input.action, provider: input.provider },
          };
        }
        return { data: { ok: true, action: input.action, provider: input.provider } };
      },
      refresh,
      navigate,
    }),
    confirmedTool({
      name: "manage_settings_payment_connection",
      title: "Manage Settings payment connection",
      description:
        "Starts Polar OAuth, refreshes safe provider status, selects a ready checkout provider, or disconnects a provider. API-key credentials remain in Bento's secure UI and are never accepted here.",
      inputSchema: {
        ...objectSchema(
          {
            action: {
              type: "string",
              enum: ["connect_polar", "open_setup", "refresh", "select", "disconnect"],
            },
            provider: paymentProvider,
          },
          ["action"],
        ),
        oneOf: actionVariants({
          connect_polar: [],
          open_setup: ["provider"],
          refresh: ["provider"],
          select: ["provider"],
          disconnect: ["provider"],
        }),
      },
      parse: (input) => paymentInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "connect_polar") {
          const result = await beginPolarConnection();
          return {
            destination: safeDestination(result.url),
            message: "Opening Polar authorization.",
            data: { ok: true, action: input.action, provider: "polar" },
          };
        }
        if (input.action === "open_setup") {
          if (!openPaymentSetup) throw new Error("Payment setup is unavailable on this page.");
          await openPaymentSetup(input.provider);
          return {
            message: `Opened secure ${input.provider} setup. Enter credentials directly in Bento.`,
            data: { ok: true, action: input.action, provider: input.provider },
            refresh: false,
          };
        }
        if (input.action === "refresh") await paymentRefreshers[input.provider]();
        else if (input.action === "select") {
          await selectCreatorPaymentProvider({ data: { provider: input.provider } });
        } else await paymentDisconnectors[input.provider]();
        return { data: { ok: true, action: input.action, provider: input.provider } };
      },
      refresh,
      navigate,
    }),
    confirmedTool({
      name: "manage_settings_billing",
      title: "Manage Settings billing",
      description:
        "Starts checkout, changes or restores a plan, opens the current cancellation offer flow, resumes a pause, or opens the secure billing portal. cancel_renewal directly schedules cancellation without reviewing an offer.",
      inputSchema: {
        ...objectSchema(
          {
            action: {
              type: "string",
              enum: [
                "start_checkout",
                "change_plan",
                "cancel_plan_change",
                "review_cancellation",
                "cancel_renewal",
                "resume_renewal",
                "resume_paused",
                "open_billing_portal",
              ],
            },
            plan: { type: "string", enum: ["store", "creator"] },
            period: { type: "string", enum: ["monthly", "yearly"] },
            reason: cancellationReason,
            details: { type: "string", maxLength: 500 },
          },
          ["action"],
        ),
        oneOf: actionVariants({
          start_checkout: ["plan", "period"],
          change_plan: ["plan"],
          cancel_plan_change: [],
          review_cancellation: [],
          cancel_renewal: ["reason"],
          resume_renewal: [],
          resume_paused: [],
          open_billing_portal: [],
        }),
      },
      parse: (input) => billingInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "start_checkout") {
          const result = await createCheckout({
            data: { plan: input.plan, period: input.period, returnTo: "dashboard" },
          });
          return {
            destination: safeDestination(result.url),
            message: "Opening secure Bento checkout.",
            data: { ok: true, action: input.action, plan: input.plan, period: input.period },
          };
        }
        if (input.action === "change_plan") {
          await changeMyPlan({ data: { plan: input.plan } });
          return { data: { ok: true, action: input.action, plan: input.plan } };
        }
        if (input.action === "review_cancellation") {
          if (!openCancellationFlow) throw new Error("The cancellation flow is unavailable here.");
          await openCancellationFlow();
          return {
            data: { ok: true, action: input.action },
            message: "Opened the current cancellation options for review.",
            refresh: false,
          };
        }
        if (input.action === "cancel_plan_change") await cancelMyPlanChange();
        else if (input.action === "cancel_renewal") {
          await cancelMyRenewal({ data: { reason: input.reason, details: input.details } });
        } else if (input.action === "resume_renewal") await resumeMyRenewal();
        else if (input.action === "resume_paused") await resumeMyPausedSubscription();
        else {
          const result = await createMyBillingPortal();
          return {
            destination: safeDestination(result.url),
            message: "Opening secure billing and invoices.",
            data: { ok: true, action: input.action },
          };
        }
        return { data: { ok: true, action: input.action } };
      },
      refresh,
      navigate,
    }),
    confirmedTool({
      name: "manage_settings_security",
      title: "Manage Settings security",
      description:
        "Sends a password-reset email, signs out this browser, or permanently deletes the recently authenticated account.",
      inputSchema: {
        ...objectSchema(
          {
            action: {
              type: "string",
              enum: ["send_password_reset", "sign_out", "delete_account"],
            },
          },
          ["action"],
        ),
        oneOf: actionVariants({ send_password_reset: [], sign_out: [], delete_account: [] }),
      },
      parse: (input) => securityInputSchema.parse(input),
      run: async (input) => {
        if (input.action === "send_password_reset") {
          const { data, error: userError } = await supabase.auth.getUser();
          if (userError || !data.user?.email) {
            throw new Error("No email is attached to this account.");
          }
          const origin = trustedApplicationOrigin(
            window.location.origin,
            import.meta.env.VITE_APP_URL,
          );
          const { error } = await supabase.auth.resetPasswordForEmail(data.user.email, {
            redirectTo: `${origin}/reset-password`,
          });
          if (error) throw new Error(error.message);
          return {
            data: { ok: true, action: input.action },
            message: "Password reset link sent.",
            refresh: false,
          };
        }
        if (input.action === "sign_out") {
          const { error } = await supabase.auth.signOut();
          if (error) throw new Error(error.message);
          return {
            destination: safeDestination("/", true),
            navigationMode: "replace",
            data: { ok: true, action: input.action },
            refresh: false,
          };
        }
        await deleteMyAccount({ data: { confirmation: "DELETE" } });
        await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
        return {
          destination: safeDestination("/", true),
          navigationMode: "replace",
          data: { ok: true, action: input.action },
          refresh: false,
        };
      },
      refresh,
      navigate,
    }),
  ];
}
