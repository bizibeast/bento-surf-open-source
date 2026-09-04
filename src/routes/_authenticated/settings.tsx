import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Compass,
  Copy,
  ExternalLink,
  Gift,
  Globe2,
  Grid2X2,
  HardDrive,
  KeyRound,
  Layers3,
  LogOut,
  Mail,
  PlugZap,
  ReceiptText,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Unplug,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import { SiRazorpay, SiStripe } from "react-icons/si";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { AppHeader } from "@/components/AppHeader";
import { MicroAppTabMotion } from "@/components/MicroAppPanel";
import { CustomDomainDialog } from "@/components/CustomDomainDialog";
import { StripeRestrictedKeyDialog } from "@/components/StripeRestrictedKeyDialog";
import { DodoApiKeyDialog } from "@/components/DodoApiKeyDialog";
import { RazorpayApiKeyDialog } from "@/components/RazorpayApiKeyDialog";
import { CreemApiKeyDialog } from "@/components/CreemApiKeyDialog";
import { PayPalApiCredentialsDialog } from "@/components/PayPalApiCredentialsDialog";
import {
  IntegrationPanel,
  IntegrationProviderCard,
  IntegrationsOverview,
} from "@/components/settings/IntegrationsOverview";
import { PaymentGatewayPicker } from "@/components/settings/PaymentGatewayPicker";
import { StorageManager } from "@/components/settings/StorageManager";
import { supabase } from "@/integrations/supabase/client";
import { safeNavigationHref, trustedApplicationOrigin } from "@/lib/safe-url";
import { getMyProfile, setAccountTimeZone, updateProfile } from "@/lib/profile.functions";
import {
  BASE_MARKETING_CONTACTS,
  CONTACT_TIER_OPTIONS,
  CONTACT_TIER_PRICING,
  isPaidPlan,
  normalizePlan,
  PLAN_CONFIG,
  PLAN_ORDER,
  PLAN_PRICING,
  planHasEntitlement,
  planName,
  storageAddonPrice,
  type PaidPlanId,
  type BillingPeriod,
  type ContactTier,
  type PlanId,
} from "@/lib/plans";
import {
  acceptMyRetentionOffer,
  cancelMyPlanChange,
  cancelMyRenewal,
  changeMyPlan,
  createMyBillingPortal,
  getMyBillingOverview,
  resumeMyRenewal,
  updateMyBillingAddons,
  type CancellationFeedback,
  type MyBillingOverview,
} from "@/lib/billing.functions";
import {
  beginPolarConnection,
  disconnectPolarConnection,
  refreshPolarConnection,
} from "@/integrations/polar/connection.functions";
import {
  disconnectStripeConnection,
  refreshStripeConnection,
} from "@/integrations/stripe/connection.functions";
import {
  disconnectPayPalConnection,
  refreshPayPalConnection,
} from "@/integrations/paypal/connection.functions";
import {
  disconnectDodoConnection,
  refreshDodoConnection,
} from "@/integrations/dodo/connection.functions";
import {
  disconnectRazorpayConnection,
  refreshRazorpayConnection,
} from "@/integrations/razorpay/connection.functions";
import {
  disconnectCreemConnection,
  refreshCreemConnection,
} from "@/integrations/creem/connection.functions";
import {
  getCreatorPaymentSettings,
  selectCreatorPaymentProvider,
} from "@/lib/payment-connections.functions";
import { formatFeeBps, type CreatorPaymentProvider } from "@/lib/payment-providers";
import {
  getMyEmailPreferences,
  updateMyEmailPreferences,
  type EmailPreferences,
} from "@/lib/email-preferences.functions";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteMyAccount } from "@/lib/account.functions";
import {
  EXPLORE_CATEGORIES,
  exploreCategorySchema,
  exploreOptInStatusCopy,
  exploreReviewStatusSchema,
  type ExploreCategory,
} from "@/lib/explore";
import { configuredMcpEndpoint, publicProfileUrl } from "@/lib/application-urls";
import { micro } from "@/lib/micro-app-ui";
import {
  detectedBrowserTimeZone,
  setBrowserTimeZoneOverride,
  supportedTimeZones,
} from "@/lib/timezones";
import { createSettingsWebMcpTools } from "@/lib/settings-webmcp";
import { useWebMcpTools } from "@/lib/webmcp";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings | bento.surf" }] }),
  validateSearch: z.object({
    section: z
      .enum([
        "overview",
        "usage",
        "plan",
        "integrations",
        "payments",
        "storage",
        "email",
        "domain",
        "embed",
        "account",
      ])
      .optional()
      .catch(undefined),
    polar: z.enum(["connected", "error"]).optional(),
    stripe: z.enum(["connected", "error"]).optional(),
    paypal: z.enum(["connected", "error"]).optional(),
    integration: z.enum(["social", "bookings", "automation", "payments"]).optional(),
  }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
    context.queryClient.prefetchQuery({
      queryKey: ["my-billing"],
      queryFn: () => getMyBillingOverview(),
    });
    context.queryClient.prefetchQuery({
      queryKey: ["creator-payment-settings"],
      queryFn: () => getCreatorPaymentSettings(),
    });
    context.queryClient.prefetchQuery({
      queryKey: ["my-email-preferences"],
      queryFn: () => getMyEmailPreferences(),
    });
  },
  component: SettingsPage,
});

const sections = [
  { id: "integrations", label: "Integrations", icon: PlugZap },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "domain", label: "Domain", icon: Globe2 },
  { id: "embed", label: "Embed", icon: Layers3 },
  { id: "email", label: "Email", icon: Mail },
  { id: "plan", label: "Billing", icon: Sparkles },
  { id: "account", label: "Account", icon: CircleUserRound },
] as const;
const TIME_ZONES = supportedTimeZones();

type SectionId = (typeof sections)[number]["id"];
type SettingsProfilePatch = {
  username?: string;
  noindex?: boolean;
  show_in_explore?: boolean;
  explore_category?: ExploreCategory;
};
const LEGACY_PAYMENT_PROVIDER_CARDS_ENABLED = false;

function PaymentProviderLogo({ provider }: { provider: CreatorPaymentProvider }) {
  const iconClass = "size-7";
  if (provider === "stripe") return <SiStripe className={iconClass} aria-hidden="true" />;
  if (provider === "paypal") return <img src="/brands/paypal.svg" alt="" className={iconClass} />;
  if (provider === "razorpay") return <SiRazorpay className={iconClass} aria-hidden="true" />;
  if (provider === "dodo")
    return (
      <img src="/brands/dodo-payments.svg?v=20260721" alt="" className="size-full object-cover" />
    );
  if (provider === "creem")
    return <img src="/brands/creem.svg?v=20260721" alt="" className="size-full object-cover" />;
  return <img src="/brands/polar.svg" alt="" className="size-7" />;
}

function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    section: requestedSection,
    polar: polarResult,
    stripe: stripeResult,
    paypal: paypalResult,
    integration: requestedIntegration,
  } = Route.useSearch();
  const active =
    requestedSection === "payments" ||
    requestedSection === "overview" ||
    requestedSection === "usage"
      ? "integrations"
      : (requestedSection ?? "integrations");
  const integrationTarget = requestedSection === "payments" ? "payments" : requestedIntegration;
  const sectionTitleRef = useRef<HTMLHeadingElement>(null);
  const [customDomainOpen, setCustomDomainOpen] = useState(false);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [stripeConnectionOpen, setStripeConnectionOpen] = useState(false);
  const [dodoConnectionOpen, setDodoConnectionOpen] = useState(false);
  const [razorpayConnectionOpen, setRazorpayConnectionOpen] = useState(false);
  const [creemConnectionOpen, setCreemConnectionOpen] = useState(false);
  const [paypalConnectionOpen, setPayPalConnectionOpen] = useState(false);
  const [cancelFlowOpen, setCancelFlowOpen] = useState(false);
  const [integrationQuery, setIntegrationQuery] = useState("");
  const [planChangeTarget, setPlanChangeTarget] = useState<PaidPlanId | null>(null);
  const { data: profile } = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  const { data: billing } = useQuery({
    queryKey: ["my-billing"],
    queryFn: () => getMyBillingOverview(),
  });
  const { data: authUser } = useQuery({
    queryKey: ["auth-user"],
    queryFn: async () => (await supabase.auth.getUser()).data.user,
  });
  const { data: paymentSettings, isLoading: paymentConnectionLoading } = useQuery({
    queryKey: ["creator-payment-settings"],
    queryFn: () => getCreatorPaymentSettings(),
  });
  const { data: emailPreferences } = useQuery({
    queryKey: ["my-email-preferences"],
    queryFn: () => getMyEmailPreferences(),
  });
  const plan = normalizePlan(profile?.plan_id, profile?.is_pro);
  const isPro = isPaidPlan(plan);
  const planLabel = planName(plan);
  const planDefinition = PLAN_CONFIG[plan];
  const username = profile?.username ?? "username";
  const profileUrl = publicProfileUrl(username, null, import.meta.env.VITE_PUBLIC_URL);
  const publicHost = new URL(profileUrl).host;
  const mcpUrl = configuredMcpEndpoint(import.meta.env.VITE_APP_URL);
  const embedTitle = escapeHtmlAttribute(`${profile?.display_name || username} on bento.surf`);
  const embedCode = `<iframe src="${escapeHtmlAttribute(profileUrl)}" title="${embedTitle}" style="width:100%;height:720px;border:0;border-radius:24px" loading="lazy"></iframe>`;

  const saveProfile = useMutation({
    mutationFn: (patch: SettingsProfilePatch) => updateProfile({ data: patch }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["my-profile"] });
      toast.success("Settings saved");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save"),
  });

  const saveTimeZone = useMutation({
    mutationFn: (manualTimeZone: string | null) =>
      setAccountTimeZone({
        data: {
          manualTimeZone,
          detectedTimeZone: detectedBrowserTimeZone(),
        },
      }),
    onSuccess: async ({ manualTimeZone }) => {
      setBrowserTimeZoneOverride(manualTimeZone);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-profile"] }),
        queryClient.invalidateQueries({ queryKey: ["booking-workspace"] }),
        queryClient.invalidateQueries({ queryKey: ["social-scheduler"] }),
        queryClient.invalidateQueries({ queryKey: ["my-commerce"] }),
        queryClient.invalidateQueries({ queryKey: ["analytics"] }),
      ]);
      toast.success("Timezone saved");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save timezone"),
  });

  const deleteAccount = useMutation({
    mutationFn: () => deleteMyAccount({ data: { confirmation: "DELETE" } }),
    onSuccess: async () => {
      await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
      window.location.replace("/");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Your account could not be deleted"),
  });

  const connectPolar = useMutation({
    mutationFn: () => beginPolarConnection(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not start Polar connection"),
  });

  const disconnectPolar = useMutation({
    mutationFn: () => disconnectPolarConnection(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] });
      toast.success("Polar disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Polar"),
  });

  const refreshPolar = useMutation({
    mutationFn: () => refreshPolarConnection(),
    onSuccess: async (connection) => {
      await queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] });
      toast.success(
        connection?.chargesEnabled && connection?.payoutsEnabled
          ? "Polar is ready and is now used for checkout"
          : "Polar status refreshed. Finish organization and payout setup in Polar.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not refresh Polar status"),
  });

  const disconnectStripe = useMutation({
    mutationFn: () => disconnectStripeConnection(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] });
      toast.success("Stripe disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Stripe"),
  });

  const refreshStripe = useMutation({
    mutationFn: () => refreshStripeConnection(),
    onSuccess: async (connection) => {
      await queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] });
      toast.success(
        connection?.chargesEnabled && connection?.payoutsEnabled
          ? "Stripe is ready for payments"
          : "Stripe status refreshed. Finish any remaining steps in Stripe.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not refresh Stripe status"),
  });

  const disconnectDodo = useMutation({
    mutationFn: () => disconnectDodoConnection(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-dodo-connection"] }),
      ]);
      toast.success("Dodo Payments disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Dodo Payments"),
  });

  const refreshDodo = useMutation({
    mutationFn: () => refreshDodoConnection(),
    onSuccess: async (connection) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-dodo-connection"] }),
      ]);
      toast.success(
        connection?.chargesEnabled
          ? "Dodo Payments is ready for checkout"
          : "Dodo status refreshed. Finish business verification in Dodo.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not refresh Dodo Payments"),
  });

  const disconnectRazorpay = useMutation({
    mutationFn: () => disconnectRazorpayConnection(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-razorpay-connection"] }),
      ]);
      toast.success("Razorpay disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Razorpay"),
  });

  const refreshRazorpay = useMutation({
    mutationFn: () => refreshRazorpayConnection(),
    onSuccess: async (connection) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-razorpay-connection"] }),
      ]);
      toast.success(
        connection?.chargesEnabled
          ? "Razorpay is ready for checkout"
          : "Razorpay keys are valid. Finish the signed webhook step.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not refresh Razorpay"),
  });

  const disconnectCreem = useMutation({
    mutationFn: () => disconnectCreemConnection(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-creem-connection"] }),
      ]);
      toast.success("Creem disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect Creem"),
  });

  const refreshCreem = useMutation({
    mutationFn: () => refreshCreemConnection(),
    onSuccess: async (connection) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-creem-connection"] }),
      ]);
      toast.success(
        connection?.chargesEnabled
          ? "Creem is ready for checkout"
          : "Creem key is valid. Finish the signed webhook step.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not refresh Creem"),
  });

  const disconnectPayPal = useMutation({
    mutationFn: () => disconnectPayPalConnection(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-paypal-connection"] }),
      ]);
      toast.success("PayPal disconnected");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not disconnect PayPal"),
  });

  const refreshPayPal = useMutation({
    mutationFn: () => refreshPayPalConnection(),
    onSuccess: async (connection) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["my-paypal-connection"] }),
      ]);
      toast.success(
        connection?.chargesEnabled
          ? "PayPal is ready for checkout"
          : "PayPal status refreshed. Reconnect the REST app to finish setup.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not refresh PayPal"),
  });

  const selectPaymentProvider = useMutation({
    mutationFn: (provider: CreatorPaymentProvider) =>
      selectCreatorPaymentProvider({ data: { provider } }),
    onSuccess: async ({ provider }) => {
      await queryClient.invalidateQueries({ queryKey: ["creator-payment-settings"] });
      toast.success(`${provider === "stripe" ? "Stripe" : provider} is now used for checkout`);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not change payment provider"),
  });

  const saveEmailPreferences = useMutation({
    mutationFn: (next: Pick<EmailPreferences, "productUpdates" | "weeklyDigest">) =>
      updateMyEmailPreferences({ data: next }),
    onSuccess: (next) => {
      queryClient.setQueryData(["my-email-preferences"], next);
      toast.success("Email preferences saved");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save email preferences"),
  });

  const cancelRenewal = useMutation({
    mutationFn: (input: { reason: CancellationFeedback; details?: string }) =>
      cancelMyRenewal({ data: input }),
    onSuccess: (next) => {
      queryClient.setQueryData<MyBillingOverview>(["my-billing"], next);
      toast.success("Renewal cancelled. Your paid access remains active until the date shown.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not cancel renewal"),
  });

  const acceptRetentionOffer = useMutation({
    mutationFn: (input: { reason: CancellationFeedback; details?: string }) =>
      acceptMyRetentionOffer({ data: input }),
    onSuccess: (next) => {
      queryClient.setQueryData<MyBillingOverview>(["my-billing"], next);
      toast.success("Three free months were added to your current plan.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not apply the offer"),
  });

  const resumeRenewal = useMutation({
    mutationFn: () => resumeMyRenewal(),
    onSuccess: (next) => {
      queryClient.setQueryData<MyBillingOverview>(["my-billing"], next);
      toast.success("Your subscription will renew normally.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not resume renewal"),
  });

  const changePlan = useMutation({
    mutationFn: (nextPlan: "store" | "creator") => changeMyPlan({ data: { plan: nextPlan } }),
    onSuccess: (result) => {
      setPlanChangeTarget(null);
      if (result.mode === "checkout") {
        const destination = safeNavigationHref(result.url);
        if (!destination) return toast.error("Checkout returned an invalid destination.");
        window.location.assign(destination);
        return;
      }
      const next = result.billing;
      queryClient.setQueryData<MyBillingOverview>(["my-billing"], next);
      toast.success(
        next.pendingPlanEffectiveAt
          ? `${planName(next.pendingPlan ?? "store")} starts after your current billing period.`
          : "Your upgrade is processing. Your plan updates as soon as payment is confirmed.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not change your plan"),
  });

  const updateBillingAddons = useMutation({
    mutationFn: (input: { contactTier: ContactTier; storageUnits: number }) =>
      updateMyBillingAddons({ data: input }),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update add-ons"),
  });

  const cancelPlanChange = useMutation({
    mutationFn: () => cancelMyPlanChange(),
    onSuccess: (next) => {
      queryClient.setQueryData<MyBillingOverview>(["my-billing"], next);
      toast.success("Your scheduled plan change was cancelled.");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not cancel the plan change"),
  });

  const openBillingPortal = useMutation({
    mutationFn: () => createMyBillingPortal(),
    onSuccess: ({ url }) => {
      const destination = safeNavigationHref(url);
      if (!destination) return toast.error("Billing returned an invalid destination.");
      window.location.assign(destination);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not open billing and invoices"),
  });

  const selectSection = (section: SectionId) => {
    void navigate({ to: "/settings", search: { section } });
  };

  useEffect(() => {
    sectionTitleRef.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    if (polarResult === "connected") toast.success("Polar connected");
    if (polarResult === "error") toast.error("Polar connection was not completed");
    if (stripeResult === "connected") toast.success("Stripe connected");
    if (stripeResult === "error") toast.error("Stripe connection was not completed");
    if (paypalResult === "connected") toast.success("PayPal connected");
    if (paypalResult === "error") toast.error("PayPal connection was not completed");
  }, [paypalResult, polarResult, stripeResult]);

  const handlePasswordReset = async () => {
    if (!authUser?.email) return toast.error("No email is attached to this account");
    const authOrigin = trustedApplicationOrigin(
      window.location.origin,
      import.meta.env.VITE_APP_URL,
    );
    const { error } = await supabase.auth.resetPasswordForEmail(authUser.email, {
      redirectTo: `${authOrigin}/reset-password`,
    });
    if (error) toast.error(error.message);
    else toast.success("Password reset link sent");
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/", replace: true });
  };

  useWebMcpTools(
    createSettingsWebMcpTools({
      refresh: () => queryClient.invalidateQueries(),
      openPaymentSetup: (provider) => {
        if (provider === "stripe") setStripeConnectionOpen(true);
        else if (provider === "dodo") setDodoConnectionOpen(true);
        else if (provider === "razorpay") setRazorpayConnectionOpen(true);
        else if (provider === "creem") setCreemConnectionOpen(true);
        else setPayPalConnectionOpen(true);
      },
    }),
  );

  return (
    <div className={`${micro.shell} selection:bg-[#3478f6] selection:text-white`}>
      <AppHeader
        title="Settings"
        actions={
          <a
            href={profileUrl}
            target="_blank"
            rel="noreferrer"
            className={`hidden sm:inline-flex ${micro.btnPrimaryCompact}`}
          >
            View profile <ExternalLink className="size-3.5" />
          </a>
        }
      />

      <div className="relative mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 md:grid-cols-[220px_minmax(0,1fr)] md:py-9">
        {!requestedSection && (
          <nav
            aria-label="Settings menu"
            className="rounded-xl border border-black/[0.06] bg-white p-2 shadow-sm md:hidden"
          >
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => selectSection(id)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left text-sm font-medium text-[#17213a] transition hover:bg-[#f2f5fb]"
              >
                <span className={`${micro.iconWell} size-9 shrink-0`}>
                  <Icon className="size-4" />
                </span>
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}
        <nav
          aria-label="Settings sections"
          className="sticky top-24 z-30 hidden h-fit flex-col gap-1 rounded-xl border border-black/[0.06] bg-white p-2 shadow-sm md:flex"
        >
          {sections.map(({ id, label, icon: Icon }) => {
            const selected = active === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => selectSection(id)}
                aria-current={selected ? "page" : undefined}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition ${
                  selected
                    ? "bg-[#17213a] text-white"
                    : "text-[#17213a]/55 hover:bg-[#f2f5fb] hover:text-[#17213a]"
                }`}
              >
                <Icon className="size-4 shrink-0" /> {label}
              </button>
            );
          })}
        </nav>

        <main className={`min-w-0 pb-24 ${requestedSection ? "" : "hidden md:block"}`}>
          {requestedSection && (
            <button
              type="button"
              onClick={() =>
                void navigate({
                  to: "/settings",
                  search: {
                    section: undefined,
                    polar: undefined,
                    stripe: undefined,
                    paypal: undefined,
                    integration: undefined,
                  },
                })
              }
              className={`mb-5 md:hidden ${micro.btnOutline}`}
            >
              <Grid2X2 className="size-4" />
              All settings
            </button>
          )}
          <MicroAppTabMotion tabKey={active} className="min-w-0">
            {active === "plan" && (
              <SettingsSection
                id="plan"
                eyebrow="Billing"
                title="Grow when your Bento is ready"
                titleRef={sectionTitleRef}
              >
                <BentoCard className="overflow-hidden">
                  <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
                    <div>
                      <div className="inline-flex rounded-lg border border-black/[0.08] bg-[#f2f5fb] px-3 py-1 text-xs font-semibold text-[#17213a]">
                        {isPro ? `${planLabel} is active` : "bento.surf Link or Store"}
                      </div>
                      <h3 className="mt-4 font-ui-display text-3xl">
                        {planDefinition.description}
                      </h3>
                      <div className="mt-4 flex flex-wrap gap-2 text-sm text-[#17213a]/52">
                        <span className="rounded-lg bg-[#f2f5fb] px-3 py-1.5">
                          {billing?.billingPeriod
                            ? `${billing.billingPeriod === "yearly" ? "Yearly" : "Monthly"} billing`
                            : "No paid billing"}
                        </span>
                        {billing?.currentPeriodEnd && (
                          <span className="rounded-lg bg-[#f2f5fb] px-3 py-1.5 font-medium text-[#17213a]">
                            {billing.cancelAtPeriodEnd
                              ? `Access ends ${formatBillingDate(billing.currentPeriodEnd)}`
                              : billing.status === "trialing"
                                ? `Trial ends ${formatBillingDate(billing.currentPeriodEnd)}`
                                : `Renews ${formatBillingDate(billing.currentPeriodEnd)}`}
                          </span>
                        )}
                        {!billing?.currentPeriodEnd && billing?.complimentaryAccessExpiresAt && (
                          <span className="rounded-lg bg-[#f2f5fb] px-3 py-1.5 font-medium text-[#17213a]">
                            Complimentary access ends{" "}
                            {formatBillingDate(billing.complimentaryAccessExpiresAt)}
                          </span>
                        )}
                      </div>
                    </div>
                    {billing?.hasSubscription && (
                      <button
                        type="button"
                        disabled={openBillingPortal.isPending}
                        onClick={() => openBillingPortal.mutate()}
                        className={`${micro.btnOutline} w-full disabled:opacity-50 md:w-auto`}
                      >
                        <ReceiptText className="size-4" />
                        {openBillingPortal.isPending ? "Opening…" : "Billing & invoices"}
                      </button>
                    )}
                  </div>
                </BentoCard>

                <div className="mt-4 grid gap-4 lg:grid-cols-3">
                  {PLAN_ORDER.map((targetPlan) => (
                    <PlanOptionCard
                      key={targetPlan}
                      plan={targetPlan}
                      currentPlan={plan}
                      billing={billing}
                      busy={changePlan.isPending || cancelRenewal.isPending}
                      onChangePlan={(nextPlan) => setPlanChangeTarget(nextPlan)}
                      onCancel={() => setCancelFlowOpen(true)}
                    />
                  ))}
                </div>
                {billing?.pendingPlan && (
                  <BentoCard className="mt-4">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <CalendarClock className="size-4" />
                          {billing.pendingPlanEffectiveAt
                            ? `${planName(billing.pendingPlan)} is scheduled`
                            : `${planName(billing.pendingPlan)} upgrade is processing`}
                        </div>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#17213a]/52">
                          {billing.pendingPlanEffectiveAt
                            ? `You keep every ${planLabel} feature until ${formatBillingDate(billing.pendingPlanEffectiveAt)}. Your account changes to ${planName(billing.pendingPlan)} only after that.`
                            : "Dodo is confirming the payment. Your current access remains safe until the change succeeds."}
                        </p>
                      </div>
                      {billing.pendingPlanEffectiveAt && (
                        <button
                          type="button"
                          disabled={cancelPlanChange.isPending}
                          onClick={() => cancelPlanChange.mutate()}
                          className={`${micro.btnOutline} shrink-0`}
                        >
                          {cancelPlanChange.isPending ? "Cancelling…" : `Keep ${planLabel}`}
                        </button>
                      )}
                    </div>
                  </BentoCard>
                )}
                {isPro && billing?.hasSubscription && !billing.pendingPlan && (
                  <BillingAddonsCard
                    billingPeriod={billing.billingPeriod ?? "monthly"}
                    billingStatus={billing.status}
                    contactTier={billing.contactTierContacts}
                    plan={plan}
                    storageUnits={billing.storageAddonUnits}
                    updating={updateBillingAddons.isPending}
                    onUpdate={(input) => updateBillingAddons.mutateAsync(input)}
                    onUpdated={async () => {
                      await queryClient.invalidateQueries({ queryKey: ["my-billing"] });
                      toast.success("Add-ons updated. Dodo may show a prorated charge.");
                    }}
                  />
                )}
                {isPro && billing?.hasSubscription && !billing.pendingPlan && (
                  <BentoCard className="mt-4">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <CalendarClock className="size-4" />
                          {billing.cancelAtPeriodEnd
                            ? "Renewal is cancelled"
                            : "Automatic renewal is on"}
                        </div>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#17213a]/52">
                          {billing.cancelAtPeriodEnd
                            ? `Your ${planLabel} access stays active until ${formatBillingDate(billing.currentPeriodEnd)}, then your account moves to Free.`
                            : `Your current trial or billing period runs through ${formatBillingDate(billing.currentPeriodEnd)}. Cancelling stops the next charge without removing access early.`}
                        </p>
                      </div>
                      {billing.cancelAtPeriodEnd ? (
                        <button
                          type="button"
                          disabled={resumeRenewal.isPending}
                          onClick={() => resumeRenewal.mutate()}
                          className={`${micro.btnPrimary} shrink-0`}
                        >
                          {resumeRenewal.isPending ? "Saving…" : "Keep my plan"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={cancelRenewal.isPending}
                          onClick={() => setCancelFlowOpen(true)}
                          className={`${micro.btnOutline} shrink-0`}
                        >
                          {cancelRenewal.isPending ? "Scheduling…" : "Downgrade to Free"}
                        </button>
                      )}
                    </div>
                  </BentoCard>
                )}
              </SettingsSection>
            )}

            {active === "integrations" && (
              <SettingsSection
                id="integrations"
                eyebrow="Integrations"
                title="Everything connected in one place"
                titleRef={sectionTitleRef}
                headerAction={
                  <label className="relative block w-full sm:w-72">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[#17213a]/40" />
                    <input
                      type="search"
                      value={integrationQuery}
                      onChange={(event) => setIntegrationQuery(event.target.value)}
                      aria-label="Search integrations"
                      placeholder="Search integrations"
                      className="integration-search-input h-10 w-full rounded-xl border border-black/[0.08] bg-white pl-10 pr-3 text-sm text-[#17213a] shadow-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#17213a]/38 focus:border-[#3478f6]/40 focus:ring-2 focus:ring-[#3478f6]/12"
                    />
                  </label>
                }
              >
                <IntegrationsOverview target={integrationTarget} query={integrationQuery} />
                <BentoCard className="mt-5">
                  <div className="flex items-start gap-3">
                    <span className={`${micro.iconWell} size-11 shrink-0`}>
                      <Bot className="size-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <CardLabel>AI agents · MCP</CardLabel>
                      <h3 className="mt-2 font-ui-display text-xl">Let your agent operate Bento</h3>
                      <p className="mt-1 text-sm leading-6 text-[#17213a]/52">
                        Add this secure MCP URL to ChatGPT, Claude, Cursor, Codex, or any compatible
                        agent. Bento will ask you to approve access in the browser.
                      </p>
                      <div className="mt-4 flex items-center gap-2 rounded-xl border border-dashed border-[#3478f6]/30 bg-[#f8faff] p-3">
                        <code className="min-w-0 flex-1 truncate text-xs text-[#17213a]/60">
                          {mcpUrl}
                        </code>
                        <CopyButton value={mcpUrl} />
                      </div>
                    </div>
                  </div>
                </BentoCard>
                <div className="mt-5">
                  <PaymentGatewayPicker
                    settings={paymentSettings}
                    loading={paymentConnectionLoading}
                    upgrade={<UpgradeDialog feature="oneTapCheckout" />}
                    pendingProvider={
                      connectPolar.isPending || refreshPolar.isPending || disconnectPolar.isPending
                        ? "polar"
                        : refreshStripe.isPending || disconnectStripe.isPending
                          ? "stripe"
                          : refreshPayPal.isPending || disconnectPayPal.isPending
                            ? "paypal"
                            : refreshRazorpay.isPending || disconnectRazorpay.isPending
                              ? "razorpay"
                              : refreshDodo.isPending || disconnectDodo.isPending
                                ? "dodo"
                                : refreshCreem.isPending || disconnectCreem.isPending
                                  ? "creem"
                                  : null
                    }
                    onConnect={(provider) => {
                      if (provider === "stripe") setStripeConnectionOpen(true);
                      else if (provider === "paypal") setPayPalConnectionOpen(true);
                      else if (provider === "razorpay") setRazorpayConnectionOpen(true);
                      else if (provider === "dodo") setDodoConnectionOpen(true);
                      else if (provider === "creem") setCreemConnectionOpen(true);
                      else connectPolar.mutate();
                    }}
                    onRefresh={(provider) => {
                      if (provider === "stripe") refreshStripe.mutate();
                      else if (provider === "paypal") refreshPayPal.mutate();
                      else if (provider === "razorpay") refreshRazorpay.mutate();
                      else if (provider === "dodo") refreshDodo.mutate();
                      else if (provider === "creem") refreshCreem.mutate();
                      else refreshPolar.mutate();
                    }}
                    onDisconnect={(provider) => {
                      const providerName =
                        paymentSettings?.providers.find((item) => item.id === provider)?.name ||
                        "this payment gateway";
                      if (
                        !window.confirm(
                          `Disconnect ${providerName}? Your store cannot accept new payments until another gateway is connected.`,
                        )
                      ) {
                        return;
                      }
                      if (provider === "stripe") disconnectStripe.mutate();
                      else if (provider === "paypal") disconnectPayPal.mutate();
                      else if (provider === "razorpay") disconnectRazorpay.mutate();
                      else if (provider === "dodo") disconnectDodo.mutate();
                      else if (provider === "creem") disconnectCreem.mutate();
                      else disconnectPolar.mutate();
                    }}
                  />
                </div>
                {LEGACY_PAYMENT_PROVIDER_CARDS_ENABLED && (
                  <div className="mt-5">
                    <IntegrationPanel
                      id="integration-payments"
                      icon={<WalletCards className="size-5" />}
                      title="Payments"
                      description="Connect a provider, choose checkout, and receive sales in your own account."
                      meta={
                        <span className="rounded-lg bg-emerald-500/12 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                          {formatFeeBps(paymentSettings?.feeBps ?? 0)} Bento fee
                        </span>
                      }
                    >
                      {paymentSettings?.locked && (
                        <div className="mb-4 rounded-[22px] border border-black/[0.07] bg-[#f8faff] p-4">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <div className="text-sm font-semibold">
                                Connected checkout is a Store feature
                              </div>
                              <p className="mt-1 text-xs leading-5 text-[#17213a]/52">
                                Existing connections remain safe. Upgrade to Store to connect or
                                select a payment provider.
                              </p>
                            </div>
                            <UpgradeDialog feature="oneTapCheckout" />
                          </div>
                        </div>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {(paymentSettings?.providers || []).map((provider) => {
                          const connection = paymentSettings?.connections.find(
                            (item: { provider: CreatorPaymentProvider }) =>
                              item.provider === provider.id,
                          );
                          const selected = paymentSettings?.selectedProvider === provider.id;
                          const connectionReady = Boolean(
                            connection?.chargesEnabled &&
                            connection?.payoutsEnabled &&
                            connection?.onboardingStatus === "complete",
                          );
                          const connectPending =
                            provider.id === "stripe" || provider.id === "paypal"
                              ? false
                              : provider.id === "razorpay"
                                ? false
                                : provider.id === "dodo"
                                  ? false
                                  : provider.id === "creem"
                                    ? false
                                    : connectPolar.isPending;
                          const disconnectPending =
                            provider.id === "stripe"
                              ? disconnectStripe.isPending
                              : provider.id === "paypal"
                                ? disconnectPayPal.isPending
                                : provider.id === "razorpay"
                                  ? disconnectRazorpay.isPending
                                  : provider.id === "dodo"
                                    ? disconnectDodo.isPending
                                    : provider.id === "creem"
                                      ? disconnectCreem.isPending
                                      : disconnectPolar.isPending;
                          return (
                            <IntegrationProviderCard
                              key={provider.id}
                              icon={
                                <span
                                  className="flex size-full items-center justify-center"
                                  style={{ color: provider.color }}
                                >
                                  <PaymentProviderLogo provider={provider.id} />
                                </span>
                              }
                              name={provider.name}
                              status={provider.shortDescription}
                              connected={connectionReady || selected}
                              statusLabel={
                                selected
                                  ? "Checkout"
                                  : connectionReady
                                    ? "Connected"
                                    : connection
                                      ? connection.onboardingStatus === "restricted"
                                        ? "Action needed"
                                        : "Finish setup"
                                      : provider.directConnect && provider.configured
                                        ? "Ready"
                                        : provider.directConnect
                                          ? "Pending"
                                          : provider.requiresProviderApproval
                                            ? "Approval needed"
                                            : "Unavailable"
                              }
                              statusTone={
                                selected
                                  ? "connected"
                                  : connectionReady
                                    ? "active"
                                    : connection?.onboardingStatus === "restricted"
                                      ? "warning"
                                      : "muted"
                              }
                            >
                              <details className="mt-4 rounded-2xl bg-[#f2f5fb] p-3.5 ring-1 ring-black/[0.06]">
                                <summary className="cursor-pointer text-sm font-semibold">
                                  How to connect
                                </summary>
                                <ol className="mt-3 space-y-2 text-xs leading-5 text-[#17213a]/52">
                                  {provider.creatorSetupSteps.map((step, index) => (
                                    <li key={step} className="flex gap-2">
                                      <span className="font-semibold text-[#17213a]/55">
                                        {index + 1}.
                                      </span>
                                      <span>{step}</span>
                                    </li>
                                  ))}
                                </ol>
                                <p className="mt-3 text-xs leading-5 text-[#17213a]/52">
                                  {provider.setupNote}
                                </p>
                                <a
                                  href={provider.docsUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#3478f6]"
                                >
                                  Official setup guide <ExternalLink className="size-3" />
                                </a>
                              </details>
                              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                                {!paymentSettings?.locked &&
                                  !connection &&
                                  provider.directConnect &&
                                  provider.configured && (
                                    <button
                                      type="button"
                                      disabled={connectPending || paymentConnectionLoading}
                                      onClick={() =>
                                        provider.id === "stripe"
                                          ? setStripeConnectionOpen(true)
                                          : provider.id === "paypal"
                                            ? setPayPalConnectionOpen(true)
                                            : provider.id === "razorpay"
                                              ? setRazorpayConnectionOpen(true)
                                              : provider.id === "dodo"
                                                ? setDodoConnectionOpen(true)
                                                : provider.id === "creem"
                                                  ? setCreemConnectionOpen(true)
                                                  : connectPolar.mutate()
                                      }
                                      className={micro.btnPrimary}
                                    >
                                      {connectPending ? "Opening…" : `Connect ${provider.name}`}
                                    </button>
                                  )}
                                {!connection && provider.directConnect && !provider.configured && (
                                  <span className="rounded-2xl bg-[#f2f5fb] px-4 py-2.5 text-xs font-semibold text-[#17213a]/52">
                                    Bento must finish provider setup
                                  </span>
                                )}
                                {!paymentSettings?.locked && connectionReady && !selected && (
                                  <button
                                    type="button"
                                    disabled={selectPaymentProvider.isPending}
                                    onClick={() => selectPaymentProvider.mutate(provider.id)}
                                    className={micro.btnPrimary}
                                  >
                                    Use for checkout
                                  </button>
                                )}
                                {connection && provider.id === "stripe" && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setStripeConnectionOpen(true)}
                                      className={micro.btnOutline}
                                    >
                                      Manage connection
                                    </button>
                                    <button
                                      type="button"
                                      disabled={refreshStripe.isPending}
                                      onClick={() => refreshStripe.mutate()}
                                      className={`${micro.btnOutline} disabled:opacity-50`}
                                    >
                                      {refreshStripe.isPending ? "Checking…" : "Check status"}
                                    </button>
                                  </>
                                )}
                                {connection && provider.id === "polar" && (
                                  <button
                                    type="button"
                                    disabled={refreshPolar.isPending}
                                    onClick={() => refreshPolar.mutate()}
                                    className={`${micro.btnOutline} disabled:opacity-50`}
                                  >
                                    {refreshPolar.isPending ? "Checking…" : "Check status"}
                                  </button>
                                )}
                                {connection && provider.id === "paypal" && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setPayPalConnectionOpen(true)}
                                      className={micro.btnOutline}
                                    >
                                      Manage connection
                                    </button>
                                    <button
                                      type="button"
                                      disabled={refreshPayPal.isPending}
                                      onClick={() => refreshPayPal.mutate()}
                                      className={`${micro.btnOutline} disabled:opacity-50`}
                                    >
                                      {refreshPayPal.isPending ? "Checking…" : "Check status"}
                                    </button>
                                  </>
                                )}
                                {connection && provider.id === "dodo" && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setDodoConnectionOpen(true)}
                                      className={micro.btnOutline}
                                    >
                                      Manage connection
                                    </button>
                                    <button
                                      type="button"
                                      disabled={refreshDodo.isPending}
                                      onClick={() => refreshDodo.mutate()}
                                      className={`${micro.btnOutline} disabled:opacity-50`}
                                    >
                                      {refreshDodo.isPending ? "Checking…" : "Check status"}
                                    </button>
                                  </>
                                )}
                                {connection && provider.id === "razorpay" && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setRazorpayConnectionOpen(true)}
                                      className={micro.btnOutline}
                                    >
                                      Manage connection
                                    </button>
                                    <button
                                      type="button"
                                      disabled={refreshRazorpay.isPending}
                                      onClick={() => refreshRazorpay.mutate()}
                                      className={`${micro.btnOutline} disabled:opacity-50`}
                                    >
                                      {refreshRazorpay.isPending ? "Checking…" : "Check status"}
                                    </button>
                                  </>
                                )}
                                {connection && provider.id === "creem" && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setCreemConnectionOpen(true)}
                                      className={micro.btnOutline}
                                    >
                                      Manage connection
                                    </button>
                                    <button
                                      type="button"
                                      disabled={refreshCreem.isPending}
                                      onClick={() => refreshCreem.mutate()}
                                      className={`${micro.btnOutline} disabled:opacity-50`}
                                    >
                                      {refreshCreem.isPending ? "Checking…" : "Check status"}
                                    </button>
                                  </>
                                )}
                                {connection && provider.directConnect && (
                                  <button
                                    type="button"
                                    disabled={disconnectPending}
                                    onClick={() =>
                                      provider.id === "stripe"
                                        ? disconnectStripe.mutate()
                                        : provider.id === "paypal"
                                          ? disconnectPayPal.mutate()
                                          : provider.id === "razorpay"
                                            ? disconnectRazorpay.mutate()
                                            : provider.id === "dodo"
                                              ? disconnectDodo.mutate()
                                              : provider.id === "creem"
                                                ? disconnectCreem.mutate()
                                                : disconnectPolar.mutate()
                                    }
                                    className={`${micro.btnOutline} disabled:opacity-50`}
                                  >
                                    <Unplug className="size-4" /> Disconnect
                                  </button>
                                )}
                                {!provider.directConnect && (
                                  <span className="rounded-2xl bg-[#f2f5fb] px-4 py-2.5 text-xs font-semibold text-[#17213a]/52">
                                    {provider.requiresProviderApproval
                                      ? "Bento platform approval required"
                                      : "OAuth connection not offered by provider"}
                                  </span>
                                )}
                              </div>
                            </IntegrationProviderCard>
                          );
                        })}
                      </div>
                      <p className="mt-4 text-xs leading-5 text-[#17213a]/52">
                        Bento charges no platform fee. Your connected provider’s processing or
                        merchant-of-record fees still apply, and sales settle directly into your
                        provider account.
                      </p>
                    </IntegrationPanel>
                  </div>
                )}
              </SettingsSection>
            )}

            {active === "email" && (
              <SettingsSection
                id="email"
                eyebrow="Email"
                title="Useful updates, on your terms"
                titleRef={sectionTitleRef}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <BentoCard>
                    <div className="flex items-start justify-between gap-5">
                      <div>
                        <CardLabel>Creator tips</CardLabel>
                        <h3 className="mt-4 font-ui-display text-2xl">Build a better Bento</h3>
                        <p className="mt-2 text-sm leading-6 text-[#17213a]/52">
                          A short onboarding series with practical setup ideas, creator-commerce
                          features, and occasional product updates.
                        </p>
                      </div>
                      <Switch
                        aria-label="Creator tips and product updates"
                        checked={emailPreferences?.productUpdates ?? true}
                        disabled={saveEmailPreferences.isPending}
                        onCheckedChange={(productUpdates) =>
                          saveEmailPreferences.mutate({
                            productUpdates,
                            weeklyDigest: emailPreferences?.weeklyDigest ?? true,
                          })
                        }
                      />
                    </div>
                  </BentoCard>
                  <BentoCard>
                    <div className="flex items-start justify-between gap-5">
                      <div>
                        <CardLabel>Weekly digest</CardLabel>
                        <h3 className="mt-4 font-ui-display text-2xl">Your week in one email</h3>
                        <p className="mt-2 text-sm leading-6 text-[#17213a]/52">
                          A Monday snapshot of visits, clicks, and sales so you can spot what is
                          working without opening the dashboard.
                        </p>
                      </div>
                      <Switch
                        aria-label="Weekly analytics digest"
                        checked={emailPreferences?.weeklyDigest ?? true}
                        disabled={saveEmailPreferences.isPending}
                        onCheckedChange={(weeklyDigest) =>
                          saveEmailPreferences.mutate({
                            productUpdates: emailPreferences?.productUpdates ?? true,
                            weeklyDigest,
                          })
                        }
                      />
                    </div>
                  </BentoCard>
                  <BentoCard className="md:col-span-2">
                    <div className="flex items-start gap-3">
                      <span className={`${micro.iconWell} size-11 shrink-0`}>
                        <ShieldCheck className="size-5" />
                      </span>
                      <div>
                        <h3 className="font-ui-display text-xl">Important emails stay on</h3>
                        <p className="mt-1 text-sm leading-6 text-[#17213a]/52">
                          Receipts, private purchase links, security messages, payment failures, and
                          account changes are transactional. We only send them when something
                          important happens, and they are not controlled by marketing preferences.
                        </p>
                      </div>
                    </div>
                  </BentoCard>
                </div>
              </SettingsSection>
            )}

            {active === "storage" && (
              <SettingsSection
                id="storage"
                eyebrow="Storage"
                title="Manage your files"
                titleRef={sectionTitleRef}
              >
                <StorageManager />
              </SettingsSection>
            )}

            {active === "domain" && (
              <SettingsSection
                id="domain"
                eyebrow="Custom domain"
                title="Make the address yours"
                titleRef={sectionTitleRef}
              >
                <BentoCard>
                  <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
                    <div>
                      <Globe2 className="size-8 text-[#3478f6]" />
                      <h3 className="mt-4 font-ui-display text-2xl">Your Bento, on your domain.</h3>
                      <p className="mt-2 max-w-xl text-sm text-[#17213a]/52">
                        Connect a domain you own. DNS checks and SSL issuance stay automatic.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCustomDomainOpen(true)}
                      className={micro.btnPrimary}
                    >
                      {isPro ? "Manage domain" : "Upgrade to connect"}
                    </button>
                  </div>
                </BentoCard>
              </SettingsSection>
            )}

            {active === "embed" && (
              <SettingsSection
                id="embed"
                eyebrow="Embed"
                title="Bring your Bento anywhere"
                titleRef={sectionTitleRef}
              >
                <BentoCard>
                  <div className="flex items-center gap-3">
                    <div className={`${micro.iconWell} size-12`}>
                      <Layers3 className="size-5" />
                    </div>
                    <div>
                      <h3 className="font-ui-display text-xl">One line, always in sync.</h3>
                      <p className="text-sm text-[#17213a]/52">
                        Paste this iframe into any website.
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 flex items-center gap-2 rounded-2xl border border-dashed border-[#3478f6]/30 bg-[#f8faff] p-3">
                    <code className="min-w-0 flex-1 truncate text-xs text-[#17213a]/52">
                      {embedCode}
                    </code>
                    <CopyButton value={embedCode} />
                  </div>
                </BentoCard>
              </SettingsSection>
            )}

            {active === "account" && (
              <SettingsSection
                id="account"
                eyebrow="Account"
                title="The practical things"
                titleRef={sectionTitleRef}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <BentoCard className="md:col-span-2">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`${micro.iconWell} size-11 shrink-0`}>
                          <Clock3 className="size-5" />
                        </span>
                        <div>
                          <CardLabel>Default timezone</CardLabel>
                          <p className="mt-2 max-w-xl text-sm leading-6 text-[#17213a]/52">
                            One timezone for analytics, calendars, bookings, and scheduled posts.
                          </p>
                        </div>
                      </div>
                      <label className="grid min-w-0 gap-2 text-xs font-semibold text-[#17213a]/55 sm:w-80">
                        Timezone
                        <select
                          aria-label="Default timezone"
                          value={profile?.account_timezone || "auto"}
                          disabled={saveTimeZone.isPending}
                          onChange={(event) =>
                            saveTimeZone.mutate(
                              event.target.value === "auto" ? null : event.target.value,
                            )
                          }
                          className="w-full rounded-lg border border-black/[0.08] bg-[#f2f5fb] px-3.5 py-2.5 text-sm font-medium text-[#17213a] outline-none transition-colors focus:border-[#3478f6]/45 disabled:opacity-50"
                        >
                          <option value="auto">Auto ({detectedBrowserTimeZone()})</option>
                          {profile?.account_timezone &&
                            !TIME_ZONES.includes(profile.account_timezone) && (
                              <option value={profile.account_timezone}>
                                {profile.account_timezone.replaceAll("_", " ")}
                              </option>
                            )}
                          {TIME_ZONES.map((timeZone) => (
                            <option key={timeZone} value={timeZone}>
                              {timeZone.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </BentoCard>
                  <BentoCard>
                    <CardLabel>Profile address</CardLabel>
                    <UsernameEditor
                      username={username}
                      publicHost={publicHost}
                      onSave={(next) => saveProfile.mutate({ username: next })}
                    />
                    <div className="mt-5 rounded-lg bg-[#f2f5fb] px-4 py-3 text-sm text-[#17213a]/52">
                      {authUser?.email ?? "Loading email…"}
                    </div>
                  </BentoCard>
                  <BentoCard>
                    <CardLabel>Security</CardLabel>
                    <button
                      type="button"
                      onClick={handlePasswordReset}
                      className="mt-4 flex w-full items-center justify-between rounded-lg bg-[#f2f5fb] px-4 py-3 text-sm font-medium transition hover:bg-[#e8eef9]"
                    >
                      <span className="inline-flex items-center gap-2">
                        <KeyRound className="size-4" /> Send password reset
                      </span>
                      <ChevronRight className="size-4 text-[#17213a]/52" />
                    </button>
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-700">
                      <ShieldCheck className="size-4" /> Your session is securely protected
                    </div>
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="mt-3 flex w-full items-center justify-between rounded-lg px-4 py-3 text-sm font-medium text-destructive ring-1 ring-destructive/20 transition hover:bg-destructive/10"
                    >
                      <span className="inline-flex items-center gap-2">
                        <LogOut className="size-4" /> Log out
                      </span>
                      <ChevronRight className="size-4" />
                    </button>
                  </BentoCard>
                  <BentoCard className="md:col-span-2">
                    <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                      <div className="max-w-2xl">
                        <CardLabel>Search visibility</CardLabel>
                        <h3 className="mt-3 font-ui-display text-2xl">
                          Let search engines show your public Bento
                        </h3>
                        <p className="mt-2 text-sm leading-6 text-[#17213a]/52">
                          Allow Google and other search engines to index your public profile and
                          published pages. Turning this off asks them to remove those pages from
                          search results.
                        </p>
                      </div>
                      <Switch
                        aria-label="Allow search engines to show my public Bento"
                        checked={!(profile?.noindex ?? false)}
                        disabled={saveProfile.isPending}
                        onCheckedChange={(allowSearchEngines) =>
                          saveProfile.mutate({ noindex: !allowSearchEngines })
                        }
                      />
                    </div>
                  </BentoCard>
                  <BentoCard className="md:col-span-2">
                    <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                      <div className="max-w-2xl">
                        <div className="flex items-center gap-3">
                          <span className={`${micro.iconWell} size-11 shrink-0`}>
                            <Compass className="size-5" />
                          </span>
                          <div>
                            <CardLabel>Explore</CardLabel>
                            <h3 className="mt-1 font-ui-display text-2xl">
                              Share your Surf for inspiration
                            </h3>
                          </div>
                        </div>
                        <p className="mt-4 text-sm leading-6 text-[#17213a]/52">
                          {exploreOptInStatusCopy(
                            profile?.show_in_explore ?? true,
                            exploreReviewStatusSchema
                              .catch("none")
                              .parse(profile?.explore_review_status),
                            profile?.explore_card_count,
                          )}
                        </p>
                      </div>
                      <Switch
                        aria-label="Show my Bento in Explore"
                        checked={profile?.show_in_explore ?? true}
                        disabled={saveProfile.isPending}
                        onCheckedChange={(show_in_explore) =>
                          saveProfile.mutate({ show_in_explore })
                        }
                      />
                    </div>
                    <div className="mt-6 grid gap-3 border-t border-black/[0.06] pt-5 sm:grid-cols-[1fr_auto] sm:items-end">
                      <label className="grid gap-2 text-sm font-medium">
                        Your Explore category
                        <select
                          value={exploreCategorySchema
                            .catch("creator")
                            .parse(profile?.explore_category)}
                          disabled={saveProfile.isPending}
                          onChange={(event) =>
                            saveProfile.mutate({
                              explore_category: exploreCategorySchema.parse(event.target.value),
                            })
                          }
                          className={`${micro.input} h-12 appearance-none disabled:opacity-60`}
                        >
                          {EXPLORE_CATEGORIES.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.choiceLabel} - {category.description}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Link
                        to="/explore"
                        search={{ q: "", page: 1 }}
                        target="_blank"
                        className={`${micro.btnOutline} h-12`}
                      >
                        Open Explore <ExternalLink className="size-3.5" />
                      </Link>
                    </div>
                  </BentoCard>
                  <BentoCard className="md:col-span-2">
                    <div className="flex h-full flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <CardLabel>Danger zone</CardLabel>
                        <h3 className="mt-3 font-ui-display text-xl">Delete your Bento account</h3>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#17213a]/52">
                          Permanently remove your pages, blocks, files, custom domain, and account.
                          Any paid Bento renewal will be cancelled first.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDeleteAccountOpen(true)}
                        className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-destructive ring-1 ring-destructive/25 transition hover:bg-destructive/10 sm:w-auto"
                      >
                        <Trash2 className="size-4" /> Delete account
                      </button>
                    </div>
                  </BentoCard>
                </div>
              </SettingsSection>
            )}
          </MicroAppTabMotion>
        </main>
      </div>

      <CustomDomainDialog
        isPro={planHasEntitlement(plan, "customDomain")}
        open={customDomainOpen}
        onOpenChange={setCustomDomainOpen}
        showTrigger={false}
      />
      <Dialog
        open={planChangeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !changePlan.isPending) setPlanChangeTarget(null);
        }}
      >
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md rounded-[28px] p-5 sm:p-6">
          <DialogHeader>
            <DialogTitle className="font-ui-display text-2xl">
              {planChangeTarget === "store" ? "Upgrade to Store?" : "Move to Link?"}
            </DialogTitle>
            <DialogDescription className="leading-6">
              {planChangeTarget === "store"
                ? "Your Store access starts as soon as the prorated payment succeeds. Dodo uses your saved payment method."
                : `You keep every Store feature until ${formatBillingDate(billing?.currentPeriodEnd ?? null)}. Link starts after that date.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:space-x-0">
            <button
              type="button"
              onClick={() => setPlanChangeTarget(null)}
              disabled={changePlan.isPending}
              className={`${micro.btnOutline} h-11 disabled:opacity-50`}
            >
              Not now
            </button>
            <button
              type="button"
              disabled={!planChangeTarget || changePlan.isPending}
              onClick={() => {
                if (planChangeTarget) changePlan.mutate(planChangeTarget);
              }}
              className={`${micro.btnPrimary} h-11`}
            >
              {changePlan.isPending
                ? "Saving…"
                : planChangeTarget === "store"
                  ? "Confirm upgrade"
                  : "Schedule downgrade"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {billing && isPro && (
        <CancellationFlowDialog
          open={cancelFlowOpen}
          onOpenChange={setCancelFlowOpen}
          plan={plan}
          billing={billing}
          onAcceptOffer={(input) => acceptRetentionOffer.mutateAsync(input)}
          onCancel={(input) => cancelRenewal.mutateAsync(input)}
        />
      )}
      <Dialog
        open={deleteAccountOpen}
        onOpenChange={(open) => {
          if (deleteAccount.isPending) return;
          setDeleteAccountOpen(open);
          if (!open) setDeleteConfirmation("");
        }}
      >
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md rounded-[28px] p-5 sm:p-6">
          <DialogHeader>
            <DialogTitle className="font-ui-display text-2xl">
              Delete account permanently?
            </DialogTitle>
            <DialogDescription className="leading-6">
              This cannot be undone. Your public Bento, content, private files, and login will be
              removed. Financial order records may be retained where required for receipts and
              compliance, without keeping your creator account. If you signed in more than ten
              minutes ago, sign out and sign back in first.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-2 text-sm font-medium" htmlFor="delete-confirmation">
            Type <strong>DELETE</strong> to confirm
            <input
              id="delete-confirmation"
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
              disabled={deleteAccount.isPending}
              className={`${micro.input} h-12 focus:border-destructive focus:ring-2 focus:ring-destructive/15`}
            />
          </label>
          <DialogFooter className="gap-2 sm:space-x-0">
            <button
              type="button"
              onClick={() => setDeleteAccountOpen(false)}
              disabled={deleteAccount.isPending}
              className={`${micro.btnOutline} h-11 disabled:opacity-50`}
            >
              Keep my account
            </button>
            <button
              type="button"
              onClick={() => deleteAccount.mutate()}
              disabled={deleteConfirmation !== "DELETE" || deleteAccount.isPending}
              className="h-11 rounded-2xl bg-destructive px-4 text-sm font-semibold text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {deleteAccount.isPending ? "Deleting…" : "Delete permanently"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <StripeRestrictedKeyDialog
        open={stripeConnectionOpen}
        onOpenChange={setStripeConnectionOpen}
      />
      <DodoApiKeyDialog open={dodoConnectionOpen} onOpenChange={setDodoConnectionOpen} />
      <RazorpayApiKeyDialog
        open={razorpayConnectionOpen}
        onOpenChange={setRazorpayConnectionOpen}
      />
      <CreemApiKeyDialog open={creemConnectionOpen} onOpenChange={setCreemConnectionOpen} />
      <PayPalApiCredentialsDialog
        open={paypalConnectionOpen}
        onOpenChange={setPayPalConnectionOpen}
      />
    </div>
  );
}

const CANCELLATION_REASONS: Array<{
  id: CancellationFeedback;
  label: string;
  helper: string;
}> = [
  { id: "too_expensive", label: "It costs too much", helper: "The price no longer fits" },
  { id: "unused", label: "I am not using it enough", helper: "I need more time to set it up" },
  {
    id: "missing_features",
    label: "A feature is missing",
    helper: "Bento does not yet cover what I need",
  },
  {
    id: "too_complex",
    label: "It is difficult to use",
    helper: "The product or setup feels confusing",
  },
  {
    id: "switched_service",
    label: "I switched to another service",
    helper: "Another tool fits my workflow better",
  },
  {
    id: "low_quality",
    label: "Something did not work well",
    helper: "Quality or reliability fell short",
  },
  {
    id: "customer_service",
    label: "I need better support",
    helper: "I could not get the help I needed",
  },
  { id: "other", label: "Another reason", helper: "Tell us in your own words" },
];

export function BillingAddonsCard({
  billingPeriod,
  billingStatus,
  contactTier: initialContactTier,
  plan,
  storageUnits: initialStorageUnits,
  updating,
  onUpdate,
  onUpdated,
}: {
  billingPeriod: BillingPeriod;
  billingStatus: MyBillingOverview["status"];
  contactTier: ContactTier;
  plan: PaidPlanId;
  storageUnits: number;
  updating: boolean;
  onUpdate: (input: { contactTier: ContactTier; storageUnits: number }) => Promise<unknown>;
  onUpdated: () => Promise<void> | void;
}) {
  const [contactTier, setContactTier] = useState<ContactTier>(initialContactTier);
  const [storageUnits, setStorageUnits] = useState(initialStorageUnits);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canUpdate = billingStatus === "active" || billingStatus === "trialing";
  const disabled = !canUpdate || updating || saving;
  const contactPrice =
    plan === "creator" && contactTier !== BASE_MARKETING_CONTACTS
      ? CONTACT_TIER_PRICING[contactTier][billingPeriod]
      : 0;
  const storagePrice = storageAddonPrice(billingPeriod, storageUnits);
  const storageUnitPrice = storageAddonPrice(billingPeriod, 1);

  useEffect(() => setContactTier(initialContactTier), [initialContactTier]);
  useEffect(() => setStorageUnits(initialStorageUnits), [initialStorageUnits]);

  const confirmUpdate = async () => {
    setSaving(true);
    setError("");
    try {
      await onUpdate({ contactTier, storageUnits });
      await onUpdated();
      setConfirmOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not update add-ons");
    } finally {
      setSaving(false);
    }
  };

  return (
    <BentoCard className="mt-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">Add-ons</h3>
        <p className="text-sm text-[#17213a]/52">
          Your verified allowance is {initialContactTier.toLocaleString()} contacts and{" "}
          {5 + initialStorageUnits * 10} GB storage.
        </p>
      </div>
      {plan === "creator" ? (
        <fieldset className="mt-5 min-w-0" disabled={disabled}>
          <legend className="text-sm font-semibold">Marketing contacts</legend>
          <p className="mt-1 text-xs text-[#17213a]/52">
            Creator includes 500 contacts and unlimited marketing sends.
          </p>
          <div className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
            {CONTACT_TIER_OPTIONS.map((tier) => {
              const selected = contactTier === tier;
              return (
                <label
                  key={tier}
                  className={`min-w-0 rounded-xl border p-2 text-xs transition focus-within:ring-2 focus-within:ring-[#3478f6]/20 ${
                    selected ? "border-[#3478f6] bg-[#dfeaff]/55" : "border-black/[0.08]"
                  }`}
                >
                  <input
                    aria-label={`${tier.toLocaleString()} contacts`}
                    checked={selected}
                    className="sr-only"
                    name="billing-contact-tier"
                    onChange={() => setContactTier(tier)}
                    type="radio"
                    value={tier}
                  />
                  <span className="block font-semibold">{tier.toLocaleString()} contacts</span>
                  <span className="mt-1 block text-[#17213a]/52">
                    {tier === BASE_MARKETING_CONTACTS
                      ? "Included"
                      : `$${CONTACT_TIER_PRICING[tier][billingPeriod]}`}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <p className="mt-5 text-sm text-[#17213a]/52">
          Email capture up to 500 contacts. Larger contact tiers are available on Creator.
        </p>
      )}
      <div className="mt-5 rounded-2xl bg-[#f2f5fb] p-4">
        <label
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm font-semibold"
          htmlFor="billing-storage-units"
        >
          Added storage in 10 GB units
          <span className="text-xs font-medium text-[#17213a]/52">
            {storageUnits * 10} GB added
          </span>
        </label>
        <input
          aria-label="Added storage in 10 GB units"
          aria-describedby="billing-storage-copy"
          className="mt-3 w-full accent-[#3478f6]"
          disabled={disabled}
          id="billing-storage-units"
          max="100"
          min="0"
          onChange={(event) => setStorageUnits(Number(event.target.value))}
          step="1"
          type="range"
          value={storageUnits}
        />
        <p id="billing-storage-copy" className="mt-2 text-xs text-[#17213a]/52">
          ${storageUnitPrice} per 10 GB {billingPeriod === "monthly" ? "per month" : "per year"}, up
          to 1 TB.
        </p>
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[#17213a]/70">
          Estimated add-ons: ${contactPrice + storagePrice}
          {billingPeriod === "monthly" ? "/month" : "/year"}. Dodo confirms prorated tax and
          currency.
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setError("");
            setConfirmOpen(true);
          }}
          className={`${micro.btnPrimary} shrink-0 disabled:opacity-50`}
        >
          {updating || saving ? "Updating…" : "Update add-ons"}
        </button>
      </div>
      {!canUpdate && (
        <p className="mt-3 text-sm text-[#17213a]/52" role="status">
          Add-ons can be changed after your subscription is active or trialing.
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Dialog open={confirmOpen} onOpenChange={(open) => !saving && setConfirmOpen(open)}>
        <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md rounded-[28px] p-5 sm:p-6">
          <DialogHeader>
            <DialogTitle className="font-ui-display text-2xl">Confirm add-on update</DialogTitle>
            <DialogDescription className="leading-6">
              Dodo will apply this {contactTier.toLocaleString()} contact and {storageUnits * 10} GB
              selection. Any charge is prorated by Dodo.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:space-x-0">
            <button
              type="button"
              disabled={saving}
              onClick={() => setConfirmOpen(false)}
              className={`${micro.btnOutline} h-11 disabled:opacity-50`}
            >
              Not now
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={confirmUpdate}
              className={`${micro.btnPrimary} h-11 disabled:opacity-50`}
            >
              {saving ? "Updating…" : "Confirm update"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BentoCard>
  );
}

function PlanOptionCard({
  plan,
  currentPlan,
  billing,
  busy,
  onChangePlan,
  onCancel,
}: {
  plan: PlanId;
  currentPlan: PlanId;
  billing: MyBillingOverview | undefined;
  busy: boolean;
  onChangePlan: (plan: PaidPlanId) => void;
  onCancel: () => void;
}) {
  const definition = PLAN_CONFIG[plan];
  const current = plan === currentPlan;
  const monthlyPrice = plan === "free" ? null : PLAN_PRICING[plan].monthly;
  const buttonClass =
    "mt-auto inline-flex min-h-11 w-full items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45";

  let action: React.ReactNode;
  if (current) {
    action = (
      <button type="button" disabled className={`${buttonClass} bg-[#f2f5fb] text-[#17213a]/52`}>
        Current plan
      </button>
    );
  } else if (plan === "free") {
    if (!billing?.hasSubscription) {
      action = (
        <button type="button" disabled className={`${buttonClass} bg-[#f2f5fb] text-[#17213a]/52`}>
          Included after paid access ends
        </button>
      );
    } else if (billing.cancelAtPeriodEnd) {
      action = (
        <button type="button" disabled className={`${buttonClass} bg-[#f2f5fb] text-[#17213a]/52`}>
          Free starts {formatBillingDate(billing.currentPeriodEnd)}
        </button>
      );
    } else {
      action = (
        <button
          type="button"
          disabled={busy || Boolean(billing.pendingPlan)}
          onClick={onCancel}
          className={`${buttonClass} ${micro.btnOutline} hover:bg-[#f2f5fb]`}
        >
          Downgrade to Free
        </button>
      );
    }
  } else if (!billing?.hasSubscription) {
    action = (
      <UpgradeDialog
        feature={plan === "store" ? "storeCards" : "postScheduler"}
        trigger={
          <button type="button" className={`${buttonClass} ${micro.btnPrimary}`}>
            Choose {planName(plan)}
          </button>
        }
      />
    );
  } else {
    const upgrade = PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(currentPlan);
    action = (
      <button
        type="button"
        disabled={busy || Boolean(billing.pendingPlan)}
        onClick={() => onChangePlan(plan)}
        className={`${buttonClass} ${upgrade ? micro.btnPrimary : micro.btnOutline}`}
      >
        {upgrade ? `Upgrade to ${planName(plan)}` : `Downgrade to ${planName(plan)}`}
      </button>
    );
  }

  return (
    <div
      className={`flex min-h-[390px] flex-col rounded-[28px] border p-5 shadow-[0_22px_60px_-46px_rgba(0,0,0,0.5)] sm:p-6 ${
        current
          ? "border-[#3478f6]/30 bg-white ring-2 ring-[#3478f6]/15"
          : "border-black/[0.07] bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-ui-display text-2xl">{definition.name}</h3>
          <p className="mt-1 text-sm text-[#17213a]/52">{definition.description}</p>
        </div>
        {current && (
          <span className="shrink-0 rounded-lg bg-[#3478f6] px-2.5 py-1 text-[11px] font-semibold text-white">
            Active
          </span>
        )}
      </div>
      <div className="mt-5 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight">{monthlyPrice?.label ?? "$0"}</span>
        <span className="text-sm text-[#17213a]/52">{monthlyPrice?.cadence ?? "/month"}</span>
      </div>
      <ul className="my-5 grid gap-2.5 text-sm text-[#17213a]/52">
        {definition.highlights.slice(0, 5).map((highlight) => (
          <li key={highlight} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-[#3478f6]" />
            <span>{highlight}</span>
          </li>
        ))}
      </ul>
      {action}
    </div>
  );
}

function CancellationFlowDialog({
  open,
  onOpenChange,
  plan,
  billing,
  onAcceptOffer,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PaidPlanId;
  billing: MyBillingOverview;
  onAcceptOffer: (input: {
    reason: CancellationFeedback;
    details?: string;
  }) => Promise<MyBillingOverview>;
  onCancel: (input: {
    reason: CancellationFeedback;
    details?: string;
  }) => Promise<MyBillingOverview>;
}) {
  const [step, setStep] = useState<"reason" | "offer" | "loss" | "confirm" | "complete">("reason");
  const [reason, setReason] = useState<CancellationFeedback | null>(null);
  const [details, setDetails] = useState("");
  const [outcome, setOutcome] = useState<"retained" | "cancelled" | null>(null);
  const [resultDate, setResultDate] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selectedReason = CANCELLATION_REASONS.find((option) => option.id === reason);
  const planLabel = planName(plan);

  useEffect(() => {
    if (open) return;
    const retentionResetTimer = window.setTimeout(() => {
      setStep("reason");
      setReason(null);
      setDetails("");
      setOutcome(null);
      setResultDate(null);
    }, 150);
    return () => window.clearTimeout(retentionResetTimer);
  }, [open]);

  const input = reason ? { reason, ...(details.trim() ? { details: details.trim() } : {}) } : null;

  const finishOffer = async () => {
    if (!input) return;
    setPending(true);
    try {
      const next = await onAcceptOffer(input);
      setOutcome("retained");
      setResultDate(next.currentPeriodEnd);
      setStep("complete");
    } catch {
      // The mutation displays a toast; keep this step open so the user can retry.
    } finally {
      setPending(false);
    }
  };

  const finishCancellation = async () => {
    if (!input) return;
    setPending(true);
    try {
      const next = await onCancel(input);
      setOutcome("cancelled");
      setResultDate(next.currentPeriodEnd);
      setStep("complete");
    } catch {
      // The mutation displays a toast; keep this step open so the user can retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto rounded-[28px] p-5 sm:p-6">
        {step === "reason" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">Before you leave</DialogTitle>
              <DialogDescription className="leading-6">
                What is the main reason you are considering cancelling {planLabel}? Your answer
                helps us offer the most relevant option.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2" role="radiogroup" aria-label="Cancellation reason">
              {CANCELLATION_REASONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={reason === option.id}
                  onClick={() => setReason(option.id)}
                  className={`rounded-2xl border p-3 text-left transition ${
                    reason === option.id
                      ? "border-[#3478f6] bg-[#dfeaff] ring-2 ring-[#3478f6]/15"
                      : "border-black/[0.08] hover:bg-[#f2f5fb]"
                  }`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-[#17213a]/52">{option.helper}</span>
                </button>
              ))}
            </div>
            {reason && (
              <label className="grid gap-2 text-sm font-medium" htmlFor="cancellation-details">
                Anything else? <span className="font-normal text-[#17213a]/52">Optional</span>
                <textarea
                  id="cancellation-details"
                  value={details}
                  maxLength={500}
                  onChange={(event) => setDetails(event.target.value)}
                  placeholder="Tell us what would make Bento work better for you"
                  className={`${micro.input} min-h-24 resize-y`}
                />
              </label>
            )}
            <DialogFooter className="gap-2 sm:space-x-0">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className={`${micro.btnOutline} h-11`}
              >
                Keep my plan
              </button>
              <button
                type="button"
                disabled={!reason}
                onClick={() => setStep(billing.retentionOfferAvailable ? "offer" : "loss")}
                className={`${micro.btnPrimary} h-11`}
              >
                Continue
              </button>
            </DialogFooter>
          </>
        )}

        {step === "offer" && (
          <>
            <DialogHeader>
              <div className={`${micro.iconWell} mb-2 size-12`}>
                <Gift className="size-6" />
              </div>
              <DialogTitle className="font-ui-display text-3xl">
                Keep {planLabel} free for 3 months
              </DialogTitle>
              <DialogDescription className="leading-6">
                {reason === "too_expensive"
                  ? "Take the pressure off your budget while keeping every paid feature."
                  : reason === "unused"
                    ? "Give yourself time to finish setup and see what works-without another charge for three months."
                    : reason === "missing_features"
                      ? "Keep your page and paid tools active while we use your feedback to improve Bento."
                      : "Keep your current page, analytics, automations, and creator tools while you decide."}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-[24px] border border-black/[0.07] bg-[#f2f5fb] p-4 text-[#17213a]">
              <div className="text-sm font-semibold">One-time account offer</div>
              <ul className="mt-3 grid gap-2 text-sm">
                <li className="flex gap-2">
                  <Check className="size-4 shrink-0" /> $0 Bento subscription charge for the next 3
                  months
                </li>
                <li className="flex gap-2">
                  <Check className="size-4 shrink-0" /> Keep every {planLabel} feature and all
                  existing data
                </li>
                <li className="flex gap-2">
                  <Check className="size-4 shrink-0" /> Normal billing resumes after the extended
                  date
                </li>
              </ul>
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <button
                type="button"
                disabled={pending}
                onClick={finishOffer}
                className={`${micro.btnPrimary} h-12 w-full`}
              >
                {pending ? "Applying offer…" : "Apply 3 free months"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setStep("loss")}
                className="h-11 w-full rounded-2xl px-4 text-sm font-semibold text-[#17213a]/52 transition hover:bg-[#f2f5fb] hover:text-[#17213a]"
              >
                No thanks, continue cancelling
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setStep("reason")}
                className="h-10 w-full text-xs font-medium text-[#17213a]/52 hover:text-[#17213a]"
              >
                Back
              </button>
            </DialogFooter>
          </>
        )}

        {step === "loss" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">
                Here is what you will miss
              </DialogTitle>
              <DialogDescription className="leading-6">
                Your content stays saved, but these {planLabel} features stop when your paid access
                ends.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-[24px] border border-black/[0.07] bg-[#f2f5fb] p-4">
              <ul className="grid gap-3 text-sm">
                {PLAN_CONFIG[plan].highlights.slice(0, 4).map((highlight) => (
                  <li key={highlight} className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-xs font-bold text-destructive"
                    >
                      ×
                    </span>
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className={`${micro.btnPrimary} h-12 w-full`}
              >
                Keep my {planLabel} plan
              </button>
              <button
                type="button"
                onClick={() => setStep("confirm")}
                className="h-11 w-full rounded-2xl px-4 text-sm font-semibold text-destructive ring-1 ring-destructive/25 transition hover:bg-destructive/10"
              >
                Continue cancelling
              </button>
              <button
                type="button"
                onClick={() => setStep(billing.retentionOfferAvailable ? "offer" : "reason")}
                className="h-10 w-full text-xs font-medium text-[#17213a]/52 hover:text-[#17213a]"
              >
                Back
              </button>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle className="font-ui-display text-2xl">
                Do you really want to cancel?
              </DialogTitle>
              <DialogDescription className="leading-6">
                Renewal will stop. Your {planLabel} features and existing content remain available
                until {formatBillingDate(billing.currentPeriodEnd)}; then the account moves to Free.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-[22px] border border-black/[0.07] bg-[#f2f5fb] p-4 text-sm">
              <span className="font-semibold">Reason:</span>{" "}
              {selectedReason?.label ?? "Not provided"}
              {details.trim() && <p className="mt-2 text-[#17213a]/52">“{details.trim()}”</p>}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
              <button
                type="button"
                disabled={pending}
                onClick={() => onOpenChange(false)}
                className={`${micro.btnPrimary} h-12 w-full`}
              >
                Keep my {planLabel} plan
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={finishCancellation}
                className="h-11 w-full rounded-2xl px-4 text-sm font-semibold text-destructive ring-1 ring-destructive/25 transition hover:bg-destructive/10 disabled:opacity-50"
              >
                {pending ? "Cancelling renewal…" : "Yes, cancel my subscription"}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setStep("loss")}
                className="h-10 w-full text-xs font-medium text-[#17213a]/52 hover:text-[#17213a]"
              >
                Back
              </button>
            </DialogFooter>
          </>
        )}

        {step === "complete" && (
          <>
            <DialogHeader>
              <div className={`${micro.iconWell} mb-2 size-12`}>
                <Check className="size-6" />
              </div>
              <DialogTitle className="font-ui-display text-2xl">
                {outcome === "retained" ? "Your 3 free months are active" : "Renewal is cancelled"}
              </DialogTitle>
              <DialogDescription className="leading-6">
                {outcome === "retained"
                  ? `You keep every ${planLabel} feature. Your next billing date is ${formatBillingDate(resultDate)}.`
                  : `You keep ${planLabel} until ${formatBillingDate(resultDate)}. After that, your account moves to Free and your existing content stays saved.`}
              </DialogDescription>
            </DialogHeader>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={`${micro.btnPrimary} h-12 w-full`}
            >
              Done
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsSection({
  id,
  eyebrow,
  title,
  titleRef,
  headerAction,
  children,
}: {
  id: SectionId;
  eyebrow: string;
  title: string;
  titleRef: React.RefObject<HTMLHeadingElement | null>;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className={micro.eyebrow}>{eyebrow}</div>
          <h2
            ref={titleRef}
            id={`${id}-title`}
            tabIndex={-1}
            className="mt-1 font-ui-display text-2xl outline-none sm:text-3xl"
          >
            {title}
          </h2>
        </div>
        {headerAction}
      </div>
      {children}
    </section>
  );
}

function BentoCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${micro.card} flex min-h-[160px] flex-col p-5 sm:p-6 ${className}`}>
      {children}
    </div>
  );
}

function CardLabel({ children }: { children: React.ReactNode }) {
  return <div className={micro.eyebrowMuted}>{children}</div>;
}
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy embed code"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success("Embed code copied");
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-[#17213a] shadow-sm ring-1 ring-black/[0.08]"
    >
      {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
    </button>
  );
}

function UsernameEditor({
  username,
  publicHost,
  onSave,
}: {
  username: string;
  publicHost: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(username);
  useEffect(() => setDraft(username), [username]);
  return (
    <div className="mt-4 flex items-center rounded-lg bg-[#f2f5fb] p-1.5 pl-4">
      <span className="text-sm text-[#17213a]/52">{publicHost}/@</span>
      <input
        value={draft}
        maxLength={24}
        onChange={(event) => setDraft(event.target.value.toLowerCase())}
        className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
      />
      <button
        type="button"
        disabled={!draft.trim() || draft === username}
        onClick={() => onSave(draft.trim())}
        className={`${micro.btnPrimaryCompact} disabled:opacity-30`}
      >
        Save
      </button>
    </div>
  );
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatBillingDate(value: string | null) {
  if (!value) return "the end of your current period";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "the end of your current period";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
