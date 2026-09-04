import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  BadgePercent,
  BarChart3,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Download,
  ExternalLink,
  GraduationCap,
  Inbox,
  Loader2,
  LockKeyhole,
  MessagesSquare,
  Newspaper,
  PackageOpen,
  Pencil,
  Plus,
  Radio,
  Repeat2,
  Send,
  ShoppingBag,
  Sparkles,
  Trash2,
  Upload,
  UsersRound,
  WalletCards,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { FileDropzone } from "@/components/blocks/FileDropzone";
import { PriceInput } from "@/components/commerce/PriceInput";
import { ProductBlockPreview } from "@/components/commerce/ProductBlockPreview";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { AppHeader } from "@/components/AppHeader";
import { MicroAppTabs } from "@/components/MicroAppTabs";
import { MicroAppTabMotion } from "@/components/MicroAppPanel";
import { micro } from "@/lib/micro-app-ui";
import { uploadFileResult } from "@/lib/upload";
import { getMyProfile } from "@/lib/profile.functions";
import { getBookingAvailabilityDefaults } from "@/lib/booking.functions";
import {
  bookingAvailabilitySettings,
  DEFAULT_AVAILABILITY,
  type Availability,
  type WeeklyRule,
} from "@/lib/booking";
import { safeMediaUrl } from "@/lib/safe-url";
import { publicProductPath } from "@/lib/application-urls";
import { creatorPaymentProvider, type CreatorPaymentProvider } from "@/lib/payment-providers";
import { browserTimeZone } from "@/lib/timezones";
import { isoToZonedDateTimeInput, zonedDateTimeInputToIso } from "@/lib/local-datetime";
import { clampProductBuilderStep, productBuilderSteps } from "@/lib/product-builder-steps";
import {
  addCommerceProductBlock,
  createCommerceProduct,
  getMyCommerce,
  setWebinarRegistrationAttendance,
  setCommerceProductStatus,
  updateCommerceProduct,
} from "@/lib/commerce.functions";
import {
  deleteCommerceDiscountCode,
  deleteCommerceOrderBump,
  saveCommerceDiscountCode,
  saveCommerceOrderBump,
} from "@/lib/commerce-growth.functions";
import { deleteCommerceProduct } from "@/lib/commerce-delete.functions";
import { TRIAL_DAYS } from "@/lib/plans";
import { createStoreWebMcpTools } from "@/lib/store-webmcp";
import { useWebMcpTools } from "@/lib/webmcp";
import {
  COMMERCE_KINDS,
  COMMERCE_PRODUCT_KINDS,
  commerceKind,
  formatCommerceMoney,
  isCommerceGrowthKind,
  isCommerceOfferKind,
  pricingLabel,
  type CommerceAsset,
  type CommerceAudienceContactRecord,
  type CommerceAudienceCampaignRecord,
  type CommerceAudienceEventRecord,
  type CommerceAudienceListRecord,
  type CommerceDiscountCodeRecord,
  type CommerceLeadRecord,
  type CommerceOrderBumpRecord,
  type CommerceOrderItemRecord,
  type CommerceLesson,
  type CommerceOrderRecord,
  type CommercePricingType,
  type CommerceProductKind,
  type CommerceProductRecord,
  type CommerceProductSettings,
  type CommerceWebinarRegistrationRecord,
} from "@/lib/commerce";

const tabSchema = z.enum(["products", "growth", "orders", "audience", "analytics", "payouts"]);
const optionalKindSchema = z.enum(COMMERCE_PRODUCT_KINDS).optional().catch(undefined);

export const Route = createFileRoute("/_authenticated/store")({
  head: () => ({ meta: [{ title: "Products" }] }),
  validateSearch: z.object({
    tab: tabSchema.default("products").catch("products"),
    create: optionalKindSchema,
    edit: z.string().uuid().optional().catch(undefined),
  }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["my-commerce"],
      queryFn: () => getMyCommerce(),
    });
    context.queryClient.prefetchQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  },
  component: ProductsPage,
});

const PRODUCT_ICONS: Record<CommerceProductKind, typeof PackageOpen> = {
  digital_product: PackageOpen,
  coaching_call: MessagesSquare,
  course: GraduationCap,
  webinar: Radio,
  paid_community: UsersRound,
  membership: Repeat2,
  custom_product: Wrench,
  priority_dm: Send,
  bundle: PackageOpen,
  newsletter: Newspaper,
  lead_form: ClipboardList,
  bento_affiliate: BadgePercent,
};

const tabs = [
  { id: "products", label: "Products", icon: ShoppingBag },
  { id: "growth", label: "Grow", icon: Sparkles },
  { id: "orders", label: "Orders", icon: Inbox },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "payouts", label: "Settlements", icon: WalletCards },
] as const;

type CommerceDashboardData = {
  products: CommerceProductRecord[];
  orders: CommerceOrderRecord[];
  leads: CommerceLeadRecord[];
  audienceContacts: CommerceAudienceContactRecord[];
  audienceEvents: CommerceAudienceEventRecord[];
  webinarRegistrations: CommerceWebinarRegistrationRecord[];
  discountCodes: CommerceDiscountCodeRecord[];
  orderBumps: CommerceOrderBumpRecord[];
  orderItems: CommerceOrderItemRecord[];
  audienceLists: CommerceAudienceListRecord[];
  audienceListMembers: Array<{ list_id: string; contact_id: string }>;
  audienceCampaigns: CommerceAudienceCampaignRecord[];
  paymentSessions: Array<{
    id: string;
    status: string;
    amount: number;
    currency: string;
    discount_amount: number;
    bump_amount: number;
    created_at: string;
  }>;
  stats: {
    products: number;
    growth: number;
    published: number;
    orders: number;
    leads: number;
    audience: number;
    checkoutStarted: number;
    checkoutCompleted: number;
    checkoutFailed: number;
    checkoutConversion: number;
    discountedCheckouts: number;
    bumpCheckouts: number;
    revenue: number;
    net: number;
    fees: number;
    currency: string | null;
    moneyByCurrency: Array<{
      currency: string;
      orders: number;
      revenue: number;
      net: number;
      fees: number;
    }>;
  };
  environment: { app: string; payments: string };
  locked?: boolean;
  plan?: "free" | "store" | "creator";
  storeSetup?: {
    ready: boolean;
    selectedProvider: CreatorPaymentProvider | null;
  };
};

function ProductsPage() {
  const { tab, create, edit } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [kindPickerOpen, setKindPickerOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<CommerceProductRecord | null>(null);
  const commerceQuery = useQuery({
    queryKey: ["my-commerce"],
    queryFn: () => getMyCommerce(),
  });
  const data = commerceQuery.data as CommerceDashboardData | undefined;
  const isLoading = commerceQuery.isLoading;
  const { data: profile } = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  const products = data?.products ?? [];
  const offers = products.filter((product) => isCommerceOfferKind(product.kind));
  const growthActions = products.filter((product) => isCommerceGrowthKind(product.kind));
  const paymentReady = Boolean(data?.storeSetup?.ready);
  const editing = edit ? products.find((product) => product.id === edit) : undefined;
  const needsBookingAvailability = create === "coaching_call" || editing?.kind === "coaching_call";
  const bookingAvailabilityQuery = useQuery({
    queryKey: ["booking-availability-defaults"],
    queryFn: () => getBookingAvailabilityDefaults(),
    enabled: needsBookingAvailability,
  });
  const editingGrowth = Boolean(
    (create && isCommerceGrowthKind(create)) || (editing && isCommerceGrowthKind(editing.kind)),
  );
  const paymentBlockedCreate = Boolean(
    data && create && isCommerceOfferKind(create) && !paymentReady,
  );
  const builderOpen = Boolean(
    (edit && editing?.kind !== "newsletter") ||
    (create && create !== "newsletter" && !paymentBlockedCreate),
  );
  const openProductCreator = () => {
    if (data?.locked) {
      toast.error("Creating and publishing products requires the Store plan.");
      return;
    }
    if (!paymentReady) {
      toast.error("Connect a payment gateway before creating a Store product.");
      document.getElementById("store-onboarding")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      return;
    }
    setKindPickerOpen(true);
  };

  useEffect(() => {
    if (tab !== "audience") return;
    void navigate({
      to: "/email-marketing",
      search: { section: "subscribers" },
      replace: true,
    });
  }, [navigate, tab]);

  useEffect(() => {
    if (!paymentBlockedCreate) return;
    toast.error("Connect a payment gateway before creating a Store product.");
    void navigate({
      to: "/store",
      search: { tab: "products", create: undefined, edit: undefined },
      replace: true,
    });
  }, [navigate, paymentBlockedCreate]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["my-commerce"] });
  };
  useWebMcpTools(createStoreWebMcpTools({ data, refresh }));

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: "published" | "archived" }) =>
      setCommerceProductStatus({ data: input }),
    onSuccess: async (_, variables) => {
      await refresh();
      toast.success(variables.status === "published" ? "Product is live" : "Product updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update product"),
  });

  const addBlockMutation = useMutation({
    mutationFn: (productId: string) =>
      addCommerceProductBlock({ data: { productId, pageId: null } }),
    onSuccess: () => toast.success("Added to your page"),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not add block"),
  });

  const deleteMutation = useMutation({
    mutationFn: (productId: string) => deleteCommerceProduct({ data: { productId } }),
    onSuccess: async (result) => {
      setProductToDelete(null);
      await refresh();
      toast.success(
        result.archived
          ? "Item archived; customer receipts and access were kept safe"
          : "Item deleted",
      );
    },
    onError: async (error) => {
      setProductToDelete(null);
      await refresh();
      toast.error(error instanceof Error ? error.message : "Could not delete item");
    },
  });

  const attendanceMutation = useMutation({
    mutationFn: (input: {
      registrationId: string;
      status: "registered" | "attended" | "no_show";
    }) => setWebinarRegistrationAttendance({ data: input }),
    onSuccess: async () => {
      await refresh();
      toast.success("Attendance updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update attendance"),
  });

  const setTab = (next: (typeof tabs)[number]["id"]) =>
    void navigate({ to: "/store", search: { tab: next, create: undefined, edit: undefined } });
  const closeBuilder = () =>
    void navigate({
      to: "/store",
      search: {
        tab: editingGrowth ? "growth" : "products",
        create: undefined,
        edit: undefined,
      },
    });

  if (tab === "audience") return null;

  if (data?.locked && products.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f7f8fc] px-5 text-[#17213a]">
        <div className="w-full max-w-2xl rounded-[36px] border border-white bg-white/80 p-8 text-center shadow-[0_35px_90px_-48px_rgba(23,33,58,0.45)] backdrop-blur-xl sm:p-12">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#dfeaff] text-[#245fd0]">
            <ShoppingBag className="size-6" />
          </span>
          <h1 className="mt-5 font-ui-display text-3xl font-normal">Turn your page into a store</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-[#17213a]/55">
            The store is included with the Store plan. Upgrade to sell digital products, coaching,
            courses, memberships, communities, collect leads, and use connected payments.
          </p>
          <UpgradeDialog
            feature="storeCards"
            trigger={
              <button className="mt-7 rounded-2xl bg-[#3478f6] px-6 py-3.5 text-sm font-semibold text-white hover:bg-[#2168e5]">
                Start a {TRIAL_DAYS}-day free trial
              </button>
            }
          />
          <div className="mt-4">
            <Link to="/link" className="text-xs font-medium text-[#17213a]/45 hover:text-[#17213a]">
              Back to my link-in-bio editor
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={micro.shell}>
      <AppHeader
        title="Creator commerce"
        actions={
          (tab === "products" || tab === "growth") && (
            <button
              type="button"
              aria-label={tab === "growth" ? "New growth action" : "New product"}
              title={tab === "growth" ? "New growth action" : "New product"}
              onClick={() => {
                if (tab === "growth") {
                  if (data?.locked) {
                    toast.error("Growth actions are included with the Store plan.");
                    return;
                  }
                  void navigate({
                    to: "/store",
                    search: { tab: "growth", create: "lead_form", edit: undefined },
                  });
                  return;
                }
                openProductCreator();
              }}
              className={micro.btnPrimaryCompact}
            >
              <Plus className="size-4" />{" "}
              <span className="hidden sm:inline">
                {tab === "growth" ? "New growth action" : "New product"}
              </span>
            </button>
          )
        }
      />

      <main className={micro.main}>
        {data?.locked && products.length > 0 && (
          <div
            className={`mb-4 flex flex-col gap-4 ${micro.bannerInfo} sm:flex-row sm:items-center sm:justify-between`}
          >
            <div>
              <div className="text-sm font-semibold">Your existing store data is safe</div>
              <p className={`mt-1 ${micro.mutedXs}`}>
                You can view, edit, archive, or delete existing items. Upgrade to Store to publish,
                add blocks, or create new ones.
              </p>
            </div>
            <UpgradeDialog feature="storeCards" />
          </div>
        )}
        {!data?.locked && offers.length > 0 && !paymentReady && (
          <div
            className={`mb-4 flex flex-col gap-4 ${micro.bannerWarn} sm:flex-row sm:items-center sm:justify-between`}
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <LockKeyhole className="size-4 text-[#b7790b]" />{" "}
                {data?.storeSetup?.selectedProvider
                  ? "Finish payment setup to keep selling"
                  : "Connect payments to start selling"}
              </div>
              <p className={`mt-1 ${micro.mutedXs}`}>
                Your existing products and customer access stay safe. New products, publishing, and
                Store blocks pause until a payment gateway is ready.
              </p>
            </div>
            <a
              href="/settings?section=integrations&integration=payments"
              className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white"
            >
              {data?.storeSetup?.selectedProvider ? "Finish payment setup" : "Connect payments"}
            </a>
          </div>
        )}
        <section className="relative overflow-hidden rounded-[34px] bg-[#17213a] p-6 text-white shadow-[0_30px_80px_-45px_rgba(23,33,58,0.8)] sm:p-8">
          <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-[#3478f6]/35 blur-2xl" />
          <div className="pointer-events-none absolute bottom-[-6rem] left-[40%] size-48 rounded-full bg-[#ffc928]/18 blur-2xl" />
          <div className="relative grid gap-7 lg:grid-cols-[1.2fr_1fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-[#dceaff]">
                <Sparkles className="size-3.5" /> Your creator business, in one application
              </div>
              <h2 className="mt-4 max-w-xl font-ui-display text-4xl leading-[1.02] sm:text-5xl">
                Turn beautiful blocks into things people can buy.
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-white/55">
                The application hosts the product page, checkout hand-off, secure delivery, audience
                data, and access experience. Your storefront stays minimal.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
              <HeroMetric label="Products" value={data?.stats.products ?? 0} />
              <HeroMetric label="Live" value={data?.stats.published ?? 0} />
              <HeroMetric label="Orders" value={data?.stats.orders ?? 0} />
              <HeroMetric
                label="Net sales"
                value={formatCommerceMoney(data?.stats.net ?? 0, "usd")}
              />
            </div>
          </div>
        </section>

        {data?.environment.payments === "mock" && (
          <div className="mt-4 flex items-start gap-3 rounded-[24px] border border-[#3478f6]/18 bg-[#dceaff] px-4 py-3.5 text-sm text-[#245fd0]">
            <Check className="mt-0.5 size-4 shrink-0" />
            <div>
              <strong>Safe test checkout is active.</strong> Orders in this deployment use mock
              money; no card is charged and no payout is created.
            </div>
          </div>
        )}

        <MicroAppTabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          ariaLabel="Commerce section"
          className="mt-6"
        />

        <MicroAppTabMotion tabKey={tab}>
          {isLoading ? (
            <div className="flex min-h-64 items-center justify-center text-[#17213a]/45">
              <Loader2 className="mr-2 size-5 animate-spin" /> Loading your shop…
            </div>
          ) : tab === "products" ? (
            offers.length === 0 && !data?.locked ? (
              <StoreOnboarding
                paymentSetup={data?.storeSetup}
                onChooseTemplate={(kind) => {
                  if (kind === "coaching_call") {
                    window.location.assign("/calendar");
                    return;
                  }
                  return navigate({
                    to: "/store",
                    search: { tab: "products", create: kind, edit: undefined },
                  });
                }}
              />
            ) : (
              <ProductsPanel
                products={offers}
                creatorUsername={profile?.username}
                webinarRegistrations={data?.webinarRegistrations ?? []}
                canSell={paymentReady}
                onCreate={openProductCreator}
                onEdit={(id) =>
                  navigate({
                    to: "/store",
                    search: { tab: "products", create: undefined, edit: id },
                  })
                }
                onStatus={(id, status) => statusMutation.mutate({ id, status })}
                onAddBlock={(id) => addBlockMutation.mutate(id)}
                onDelete={(product) => setProductToDelete(product)}
                onAttendance={(registrationId, status) =>
                  attendanceMutation.mutate({ registrationId, status })
                }
              />
            )
          ) : tab === "growth" ? (
            <GrowthPanel
              actions={growthActions}
              creatorUsername={profile?.username}
              products={offers}
              discountCodes={data?.discountCodes ?? []}
              orderBumps={data?.orderBumps ?? []}
              locked={Boolean(data?.locked)}
              onRefresh={refresh}
              onCreate={(kind) =>
                navigate({
                  to: "/store",
                  search: { tab: "growth", create: kind, edit: undefined },
                })
              }
              onEdit={(id) =>
                navigate({
                  to: "/store",
                  search: { tab: "growth", create: undefined, edit: id },
                })
              }
              onStatus={(id, status) => statusMutation.mutate({ id, status })}
              onAddBlock={(id) => addBlockMutation.mutate(id)}
              onDelete={(product) => setProductToDelete(product)}
            />
          ) : tab === "orders" ? (
            <OrdersPanel
              orders={data?.orders ?? []}
              products={products}
              totalOrders={data?.stats.orders ?? 0}
            />
          ) : tab === "analytics" ? (
            <StoreAnalyticsPanel data={data} />
          ) : (
            <PayoutsPanel data={data} />
          )}
        </MicroAppTabMotion>
      </main>

      <ProductKindPicker
        open={kindPickerOpen}
        onOpenChange={setKindPickerOpen}
        onChoose={(kind) => {
          setKindPickerOpen(false);
          void navigate({
            to: "/store",
            search: { tab: "products", create: kind, edit: undefined },
          });
        }}
      />

      {editingGrowth ? (
        <GrowthActionBuilder
          open={builderOpen}
          kind={create ?? (editing?.kind as CommerceProductKind | undefined)}
          action={editing}
          onOpenChange={(open) => {
            if (!open) closeBuilder();
          }}
          onSaved={async () => {
            await refresh();
            closeBuilder();
          }}
        />
      ) : (
        <ProductBuilder
          open={builderOpen}
          kind={create ?? (editing?.kind as CommerceProductKind | undefined)}
          product={editing}
          profile={profile}
          bookingAvailability={bookingAvailabilityQuery.data}
          bookingAvailabilityLoading={
            needsBookingAvailability && bookingAvailabilityQuery.isLoading
          }
          products={offers}
          onOpenChange={(open) => {
            if (!open) closeBuilder();
          }}
          onSaved={async () => {
            await refresh();
            closeBuilder();
          }}
        />
      )}

      {productToDelete && (
        <DeleteProductDialog
          product={productToDelete}
          busy={deleteMutation.isPending}
          onClose={() => {
            if (!deleteMutation.isPending) setProductToDelete(null);
          }}
          onConfirm={() => deleteMutation.mutate(productToDelete.id)}
        />
      )}
    </div>
  );
}

function HeroMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[22px] border border-white/10 bg-white/[0.07] p-4 backdrop-blur-xl">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
        {label}
      </div>
      <div className="mt-2 font-ui-display text-2xl tabular-nums">{value}</div>
    </div>
  );
}

const STORE_STARTER_TEMPLATES: Array<{
  kind: CommerceProductKind;
  eyebrow: string;
  title: string;
  body: string;
}> = [
  {
    kind: "digital_product",
    eyebrow: "Files",
    title: "Digital download",
    body: "Sell an ebook, guide, template, preset, or resource pack.",
  },
  {
    kind: "coaching_call",
    eyebrow: "Time",
    title: "1:1 coaching",
    body: "Offer a paid strategy call, consultation, or portfolio review.",
  },
  {
    kind: "course",
    eyebrow: "Learning",
    title: "Mini course",
    body: "Package videos, files, links, and written lessons into a course.",
  },
  {
    kind: "webinar",
    eyebrow: "Live",
    title: "Live workshop",
    body: "Sell seats for a webinar, cohort session, or live class.",
  },
  {
    kind: "paid_community",
    eyebrow: "Access",
    title: "Paid community",
    body: "Create a member space with paid access and conversations.",
  },
  {
    kind: "membership",
    eyebrow: "Recurring",
    title: "Membership",
    body: "Offer ongoing access, resources, or benefits on a subscription.",
  },
];

function StoreOnboarding({
  paymentSetup,
  onChooseTemplate,
}: {
  paymentSetup?: CommerceDashboardData["storeSetup"];
  onChooseTemplate: (kind: CommerceProductKind) => void;
}) {
  const paymentReady = Boolean(paymentSetup?.ready);
  const selectedProvider = paymentSetup?.selectedProvider
    ? creatorPaymentProvider(paymentSetup.selectedProvider)
    : null;
  return (
    <section
      id="store-onboarding"
      className="scroll-mt-28 overflow-hidden rounded-[32px] border border-black/[0.07] bg-white shadow-[0_28px_70px_-48px_rgba(23,33,58,0.45)]"
    >
      <div className="border-b border-black/[0.06] px-5 py-6 sm:px-8 sm:py-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#3478f6]">
              Store setup
            </div>
            <h3 className="mt-2 font-ui-display text-3xl leading-tight sm:text-4xl">
              Make your first sale, one step at a time.
            </h3>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[#17213a]/52">
              Connect where money should go, start from a useful template, then customise the live
              product card before it reaches your page.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs sm:min-w-[390px]">
            {[
              { label: "Payments", complete: paymentReady },
              { label: "Template", complete: false },
              { label: "Publish", complete: false },
            ].map((step, index) => (
              <div key={step.label} className="min-w-0">
                <div
                  className={`h-1.5 rounded-full ${
                    step.complete || (paymentReady && index === 1)
                      ? "bg-[#3478f6]"
                      : "bg-[#17213a]/10"
                  }`}
                />
                <div className="mt-2 truncate font-medium text-[#17213a]/55">
                  {index + 1}. {step.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {!paymentReady ? (
        <div className="grid gap-6 px-5 py-7 sm:px-8 sm:py-9 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="flex min-w-0 gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#dceaff] text-[#245fd0]">
              <CircleDollarSign className="size-5" />
            </span>
            <div>
              <div className="text-xs font-semibold text-[#3478f6]">Step 1 of 3</div>
              <h4 className="mt-1 font-ui-display text-2xl">Connect your payment gateway</h4>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[#17213a]/52">
                Store products stay locked until the application verifies that payments, payouts,
                and the webhook are ready. Sales then settle directly into your provider account.
              </p>
              {selectedProvider && (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#f2f5fb] px-3 py-1.5 text-xs font-medium text-[#17213a]/65">
                  <span className="size-2 rounded-full bg-[#f2b84b]" />
                  {selectedProvider.name} selected. Setup is not finished
                </div>
              )}
            </div>
          </div>
          <a
            href="/settings?section=integrations&integration=payments"
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#263252]"
          >
            {selectedProvider ? `Finish ${selectedProvider.name} setup` : "Connect payments"}
            <ChevronRight className="size-4" />
          </a>
        </div>
      ) : (
        <div className="px-5 py-7 sm:px-8 sm:py-9">
          <div className="flex items-start gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#e7f7ee] text-[#197a4d]">
              <Check className="size-5" />
            </span>
            <div>
              <div className="text-xs font-semibold text-[#197a4d]">
                Step 1 complete · {selectedProvider?.name || "Payments"} connected
              </div>
              <h4 className="mt-1 font-ui-display text-2xl">What would you like to sell first?</h4>
              <p className="mt-2 text-sm leading-6 text-[#17213a]/52">
                Choose a starting point. You can change every detail in the next step.
              </p>
            </div>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {STORE_STARTER_TEMPLATES.map((template) => {
              const definition = commerceKind(template.kind);
              const Icon = PRODUCT_ICONS[template.kind];
              return (
                <button
                  key={template.kind}
                  type="button"
                  onClick={() => onChooseTemplate(template.kind)}
                  className="group flex min-h-40 flex-col rounded-[24px] border border-black/[0.07] bg-[#f8faff] p-4 text-left transition hover:-translate-y-1 hover:border-[#3478f6]/28 hover:bg-[#eef5ff] hover:shadow-lg"
                >
                  <div className="flex items-start justify-between">
                    <span
                      className="flex size-10 items-center justify-center rounded-2xl text-white"
                      style={{ background: definition.accent }}
                    >
                      <Icon className="size-4.5" />
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/35">
                      {template.eyebrow}
                    </span>
                  </div>
                  <div className="mt-4 font-ui-display text-xl">{template.title}</div>
                  <p className="mt-1 text-xs leading-5 text-[#17213a]/48">{template.body}</p>
                  <span className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-semibold text-[#245fd0]">
                    Use template{" "}
                    <ChevronRight className="size-3.5 transition group-hover:translate-x-0.5" />
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => onChooseTemplate("custom_product")}
            className="mt-4 text-xs font-semibold text-[#17213a]/48 underline decoration-[#17213a]/20 underline-offset-4 hover:text-[#17213a]"
          >
            Start with a blank custom product instead
          </button>
        </div>
      )}
    </section>
  );
}

function ProductsPanel({
  products,
  creatorUsername,
  webinarRegistrations,
  canSell,
  onCreate,
  onEdit,
  onStatus,
  onAddBlock,
  onDelete,
  onAttendance,
}: {
  products: CommerceProductRecord[];
  creatorUsername?: string;
  webinarRegistrations: CommerceWebinarRegistrationRecord[];
  canSell: boolean;
  onCreate: () => void;
  onEdit: (id: string) => void;
  onStatus: (id: string, status: "published" | "archived") => void;
  onAddBlock: (id: string) => void;
  onDelete: (product: CommerceProductRecord) => void;
  onAttendance: (registrationId: string, status: "registered" | "attended" | "no_show") => void;
}) {
  if (products.length === 0) {
    return (
      <div className="rounded-[32px] border border-dashed border-[#3478f6]/30 bg-white p-10 text-center shadow-sm">
        <div className="mx-auto flex size-16 items-center justify-center rounded-[24px] bg-[#dceaff] text-[#3478f6]">
          <ShoppingBag className="size-7" />
        </div>
        <h3 className="mt-5 font-ui-display text-3xl">Your first offer belongs here.</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#17213a]/50">
          Pick a product type. The application creates its setup flow, hosted page, and storefront
          block.
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="mt-6 rounded-2xl bg-[#3478f6] px-5 py-3 text-sm font-semibold text-white"
        >
          Create a product
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {products.map((product) => {
        const definition = commerceKind(product.kind);
        const Icon = PRODUCT_ICONS[product.kind as CommerceProductKind];
        const coverUrl = safeMediaUrl(product.cover_url);
        const registrations =
          product.kind === "webinar"
            ? webinarRegistrations.filter((item) => item.product_id === product.id)
            : [];
        return (
          <article
            key={product.id}
            className="group overflow-hidden rounded-[30px] border border-black/[0.07] bg-white shadow-[0_24px_60px_-44px_rgba(23,33,58,0.5)]"
          >
            <div
              className="relative flex h-40 items-start justify-between overflow-hidden p-5"
              style={{
                background: coverUrl
                  ? `linear-gradient(180deg,rgba(23,33,58,.05),rgba(23,33,58,.52)),url("${coverUrl.replaceAll('"', "%22")}") center/cover`
                  : `linear-gradient(145deg,${definition.accent}28,#f8faff 68%)`,
              }}
            >
              <span
                className="flex size-11 items-center justify-center rounded-2xl shadow-sm"
                style={{
                  background: coverUrl ? "rgba(255,255,255,.9)" : definition.accent,
                  color: coverUrl ? definition.accent : "white",
                }}
              >
                <Icon className="size-5" />
              </span>
              <StatusPill status={product.status} />
            </div>
            <div className="p-5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#17213a]/40">
                {definition.label}
              </div>
              <h3 className="mt-1 line-clamp-2 font-ui-display text-2xl leading-tight">
                {product.title}
              </h3>
              <div className="mt-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-semibold">
                  {pricingLabel(
                    product.pricing_type,
                    product.price_amount,
                    product.currency,
                    product.billing_interval,
                  )}
                </span>
                <span className="text-[#17213a]/42">{product.sales_count || 0} sales</span>
              </div>
              {product.kind === "webinar" && (
                <details className="mt-4 rounded-2xl border border-[#e24c5a]/12 bg-[#fff6f7] p-3">
                  <summary className="cursor-pointer list-none text-xs font-semibold text-[#b52f3d]">
                    {registrations.filter((item) => item.status !== "canceled").length} registered ·{" "}
                    {registrations.filter((item) => item.status === "attended").length} attended
                  </summary>
                  <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                    {registrations.length ? (
                      registrations.map((registration) => (
                        <div
                          key={registration.id}
                          className="min-w-0 rounded-xl border border-black/[0.05] bg-white p-3"
                        >
                          <div className="truncate text-xs font-semibold">
                            {registration.buyer_name || registration.buyer_email}
                          </div>
                          <div className="mt-0.5 truncate text-[10px] text-[#17213a]/42">
                            {registration.buyer_email}
                          </div>
                          {registration.status === "canceled" ? (
                            <div className="mt-2 text-[10px] font-semibold text-[#17213a]/38">
                              Canceled
                            </div>
                          ) : (
                            <div className="mt-2 grid grid-cols-3 gap-1">
                              {(["registered", "attended", "no_show"] as const).map((status) => (
                                <button
                                  key={status}
                                  type="button"
                                  onClick={() => onAttendance(registration.id, status)}
                                  className={`min-w-0 rounded-lg px-1.5 py-1.5 text-[9px] font-semibold capitalize ${
                                    registration.status === status
                                      ? "bg-[#17213a] text-white"
                                      : "bg-[#f2f5fb] text-[#17213a]/55"
                                  }`}
                                >
                                  {status.replace("_", " ")}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="text-[11px] leading-5 text-[#17213a]/42">
                        Registrations appear here after checkout.
                      </div>
                    )}
                  </div>
                </details>
              )}
              <div className="mt-5 grid grid-cols-2 gap-2">
                {product.kind === "newsletter" ? (
                  <Link
                    to="/email-marketing"
                    search={{ section: "overview" }}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#dceaff] px-3 py-2.5 text-xs font-semibold text-[#245fd0]"
                  >
                    <Newspaper className="size-3.5" /> Manage in Email Marketing
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => onEdit(product.id)}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#f2f5fb] px-3 py-2.5 text-xs font-semibold hover:bg-[#e8eef9]"
                  >
                    <Pencil className="size-3.5" /> Edit
                  </button>
                )}
                {product.status === "published" ? (
                  <a
                    href={
                      creatorUsername
                        ? publicProductPath(creatorUsername, product.public_slug)
                        : `/p/${product.slug}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#17213a] px-3 py-2.5 text-xs font-semibold text-white"
                  >
                    View <ExternalLink className="size-3.5" />
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled={!canSell}
                    title={!canSell ? "Connect a payment gateway before publishing" : undefined}
                    onClick={() => canSell && onStatus(product.id, "published")}
                    className="rounded-xl bg-[#3478f6] px-3 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#17213a]/12 disabled:text-[#17213a]/40"
                  >
                    {canSell
                      ? product.status === "archived"
                        ? "Restore"
                        : "Publish"
                      : "Payments required"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canSell}
                  title={
                    !canSell ? "Connect a payment gateway before adding Store blocks" : undefined
                  }
                  onClick={() => canSell && onAddBlock(product.id)}
                  className="rounded-xl border border-black/[0.08] px-3 py-2.5 text-xs font-semibold hover:bg-[#f7f8fc] disabled:cursor-not-allowed disabled:text-[#17213a]/30 disabled:hover:bg-transparent"
                >
                  {canSell ? "Add block" : "Block locked"}
                </button>
                {product.status !== "archived" && (
                  <button
                    type="button"
                    onClick={() => onStatus(product.id, "archived")}
                    className="rounded-xl border border-black/[0.08] px-3 py-2.5 text-xs font-semibold text-[#17213a]/55 hover:bg-[#f7f8fc]"
                  >
                    Archive
                  </button>
                )}
                {(product.kind === "paid_community" || product.kind === "membership") && (
                  <Link
                    to="/community"
                    search={{ tab: "overview", community: product.id }}
                    className="col-span-2 inline-flex items-center justify-center gap-2 rounded-xl bg-[#e7f7ee] px-3 py-2.5 text-xs font-semibold text-[#197a4d] transition hover:bg-[#d9f2e5]"
                  >
                    <UsersRound className="size-3.5" /> Manage community
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => onDelete(product)}
                  className="col-span-2 inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-100"
                >
                  <Trash2 className="size-3.5" /> Delete product
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function GrowthPanel({
  actions,
  creatorUsername,
  products,
  discountCodes,
  orderBumps,
  locked,
  onRefresh,
  onCreate,
  onEdit,
  onStatus,
  onAddBlock,
  onDelete,
}: {
  actions: CommerceProductRecord[];
  creatorUsername?: string;
  products: CommerceProductRecord[];
  discountCodes: CommerceDiscountCodeRecord[];
  orderBumps: CommerceOrderBumpRecord[];
  locked: boolean;
  onRefresh: () => Promise<void>;
  onCreate: (kind: "lead_form" | "bento_affiliate") => void;
  onEdit: (id: string) => void;
  onStatus: (id: string, status: "published" | "archived") => void;
  onAddBlock: (id: string) => void;
  onDelete: (action: CommerceProductRecord) => void;
}) {
  return (
    <div className="space-y-4">
      <GrowthPromotions
        products={products}
        discountCodes={discountCodes}
        orderBumps={orderBumps}
        locked={locked}
        onRefresh={onRefresh}
      />
      {!actions.length ? (
        <div className="rounded-[32px] border border-dashed border-[#8067e8]/30 bg-white p-6 text-center shadow-sm sm:p-10">
          <div className="mx-auto flex size-16 items-center justify-center rounded-[24px] bg-[#ece7ff] text-[#7654c7]">
            <Sparkles className="size-7" />
          </div>
          <h3 className="mt-5 font-ui-display text-3xl">Grow without creating a product.</h3>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[#17213a]/50">
            Collect emails and applications, or add your tracked referral link. These are simple
            actions-not items for sale.
          </p>
          <div className="mx-auto mt-6 grid max-w-xl gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onCreate("lead_form")}
              className="rounded-[22px] bg-[#8067e8] px-5 py-4 text-sm font-semibold text-white"
            >
              Collect emails or applications
            </button>
            <button
              type="button"
              onClick={() => onCreate("bento_affiliate")}
              className="rounded-[22px] bg-[#f0ad00] px-5 py-4 text-sm font-semibold text-[#17213a]"
            >
              Add my affiliate link
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-[26px] border border-black/[0.06] bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold">Growth actions</div>
              <p className="mt-1 text-xs leading-5 text-[#17213a]/48">
                Lightweight lead and referral blocks. No pricing, checkout, delivery, or fake
                product setup.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => onCreate("lead_form")}
                className="rounded-xl bg-[#8067e8] px-4 py-2.5 text-xs font-semibold text-white"
              >
                New lead form
              </button>
              <button
                type="button"
                onClick={() => onCreate("bento_affiliate")}
                className="rounded-xl bg-[#fff0b8] px-4 py-2.5 text-xs font-semibold text-[#7b5800]"
              >
                New affiliate link
              </button>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {actions.map((action) => {
              const definition = commerceKind(action.kind);
              const Icon = PRODUCT_ICONS[action.kind];
              return (
                <article
                  key={action.id}
                  className="rounded-[28px] border border-black/[0.07] bg-white p-5 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span
                      className="flex size-11 items-center justify-center rounded-2xl text-white"
                      style={{ background: definition.accent }}
                    >
                      <Icon className="size-5" />
                    </span>
                    <StatusPill status={action.status} />
                  </div>
                  <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#17213a]/40">
                    {definition.label}
                  </div>
                  <h3 className="mt-1 font-ui-display text-2xl">{action.title}</h3>
                  <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-[#17213a]/48">
                    {action.subtitle || definition.description}
                  </p>
                  <div className="mt-5 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(action.id)}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#f2f5fb] px-3 py-2.5 text-xs font-semibold"
                    >
                      <Pencil className="size-3.5" /> Edit
                    </button>
                    {action.status === "published" ? (
                      <a
                        href={
                          creatorUsername
                            ? publicProductPath(creatorUsername, action.public_slug)
                            : `/p/${action.slug}`
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#17213a] px-3 py-2.5 text-xs font-semibold text-white"
                      >
                        View <ExternalLink className="size-3.5" />
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onStatus(action.id, "published")}
                        className="rounded-xl bg-[#3478f6] px-3 py-2.5 text-xs font-semibold text-white"
                      >
                        {action.status === "archived" ? "Restore" : "Publish"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onAddBlock(action.id)}
                      className="rounded-xl border border-black/[0.08] px-3 py-2.5 text-xs font-semibold"
                    >
                      Add block
                    </button>
                    {action.status !== "archived" && (
                      <button
                        type="button"
                        onClick={() => onStatus(action.id, "archived")}
                        className="rounded-xl border border-black/[0.08] px-3 py-2.5 text-xs font-semibold text-[#17213a]/55"
                      >
                        Archive
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDelete(action)}
                      className="col-span-2 inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600"
                    >
                      <Trash2 className="size-3.5" /> Delete action
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function GrowthPromotions({
  products,
  discountCodes,
  orderBumps,
  locked,
  onRefresh,
}: {
  products: CommerceProductRecord[];
  discountCodes: CommerceDiscountCodeRecord[];
  orderBumps: CommerceOrderBumpRecord[];
  locked: boolean;
  onRefresh: () => Promise<void>;
}) {
  const eligibleProducts = products.filter((product) => product.pricing_type === "one_time");
  const [code, setCode] = useState("");
  const [percent, setPercent] = useState("10");
  const [discountProductId, setDiscountProductId] = useState("");
  const [primaryProductId, setPrimaryProductId] = useState("");
  const [bumpProductId, setBumpProductId] = useState("");
  const [bumpHeadline, setBumpHeadline] = useState("Add this to my order");
  const saveDiscount = useMutation({
    mutationFn: () =>
      saveCommerceDiscountCode({
        data: {
          code,
          productId: discountProductId || null,
          discountType: "percent",
          discountValue: Math.round(Number(percent) * 100),
          currency: null,
          maxRedemptionsPerEmail: 1,
          isActive: true,
        },
      }),
    onSuccess: async () => {
      setCode("");
      await onRefresh();
      toast.success("Discount code created");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Discount could not be created"),
  });
  const removeDiscount = useMutation({
    mutationFn: (id: string) => deleteCommerceDiscountCode({ data: { id } }),
    onSuccess: async () => {
      await onRefresh();
      toast.success("Discount removed");
    },
  });
  const saveBump = useMutation({
    mutationFn: () =>
      saveCommerceOrderBump({
        data: {
          primaryProductId,
          bumpProductId,
          headline: bumpHeadline,
          description: "",
          isActive: true,
        },
      }),
    onSuccess: async () => {
      setPrimaryProductId("");
      setBumpProductId("");
      await onRefresh();
      toast.success("Order bump created");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Order bump could not be created"),
  });
  const removeBump = useMutation({
    mutationFn: (id: string) => deleteCommerceOrderBump({ data: { id } }),
    onSuccess: async () => {
      await onRefresh();
      toast.success("Order bump removed");
    },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  if (locked) {
    return (
      <div className="rounded-[30px] border border-[#f0ad00]/25 bg-[#fff9e8] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-ui-display text-2xl">Promotions are locked</div>
            <p className="mt-1 max-w-xl text-sm leading-6 text-[#17213a]/55">
              Discount codes and one-click order bumps are included with the Store plan. Existing
              store data stays safe after a downgrade.
            </p>
          </div>
          <Link
            to="/settings"
            search={{ section: "plan" }}
            className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
          >
            Upgrade to Store
          </Link>
        </div>
      </div>
    );
  }

  return (
    <section className="rounded-[30px] border border-black/[0.06] bg-white p-4 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#fff0b8] text-[#7b5800]">
          <BadgePercent className="size-5" />
        </span>
        <div>
          <h2 className="font-ui-display text-2xl">Promotions</h2>
          <p className="mt-1 text-sm leading-5 text-[#17213a]/48">
            Increase conversion without changing your original product or delivery.
          </p>
        </div>
      </div>
      {!eligibleProducts.length ? (
        <p className="mt-5 rounded-2xl bg-[#f6f7fa] p-4 text-sm text-[#17213a]/50">
          Publish a one-time product before creating a discount or order bump.
        </p>
      ) : (
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <form
            className="min-w-0 rounded-[24px] border border-black/[0.06] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveDiscount.mutate();
            }}
          >
            <div className="font-semibold">New discount code</div>
            <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-[1fr_100px]">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="WELCOME10"
                required
                maxLength={32}
                className={inputClass}
              />
              <div className="relative">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={percent}
                  onChange={(event) => setPercent(event.target.value)}
                  required
                  aria-label="Discount percentage"
                  className={`${inputClass} pr-8`}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#17213a]/40">
                  %
                </span>
              </div>
            </div>
            <select
              value={discountProductId}
              onChange={(event) => setDiscountProductId(event.target.value)}
              className={`${inputClass} mt-2`}
            >
              <option value="">All one-time products</option>
              {eligibleProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={saveDiscount.isPending}
              className="mt-3 w-full rounded-xl bg-[#17213a] px-4 py-3 text-xs font-semibold text-white disabled:opacity-50"
            >
              Create discount
            </button>
            <div className="mt-3 space-y-2">
              {discountCodes.map((discount) => (
                <div
                  key={discount.id}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-[#f6f7fa] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">{discount.code}</div>
                    <div className="truncate text-[10px] text-[#17213a]/45">
                      {discount.discount_type === "percent"
                        ? `${discount.discount_value / 100}% off`
                        : `${formatCommerceMoney(discount.discount_value, discount.currency || "usd")} off`}
                      {discount.product_id
                        ? ` · ${byId.get(discount.product_id)?.title || "One product"}`
                        : " · All products"}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete ${discount.code}`}
                    onClick={() => removeDiscount.mutate(discount.id)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-red-500 hover:bg-red-50"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </form>
          <form
            className="min-w-0 rounded-[24px] border border-black/[0.06] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveBump.mutate();
            }}
          >
            <div className="font-semibold">New order bump</div>
            <select
              value={primaryProductId}
              onChange={(event) => setPrimaryProductId(event.target.value)}
              required
              className={`${inputClass} mt-3`}
            >
              <option value="">Product shown first</option>
              {eligibleProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))}
            </select>
            <select
              value={bumpProductId}
              onChange={(event) => setBumpProductId(event.target.value)}
              required
              className={`${inputClass} mt-2`}
            >
              <option value="">Add-on product</option>
              {eligibleProducts
                .filter((product) => product.id !== primaryProductId)
                .map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.title} · {formatCommerceMoney(product.price_amount, product.currency)}
                  </option>
                ))}
            </select>
            <input
              value={bumpHeadline}
              onChange={(event) => setBumpHeadline(event.target.value)}
              required
              maxLength={120}
              className={`${inputClass} mt-2`}
              placeholder="Add this to my order"
            />
            <button
              type="submit"
              disabled={saveBump.isPending}
              className="mt-3 w-full rounded-xl bg-[#f0ad00] px-4 py-3 text-xs font-semibold text-[#17213a] disabled:opacity-50"
            >
              Create order bump
            </button>
            <div className="mt-3 space-y-2">
              {orderBumps.map((bump) => (
                <div
                  key={bump.id}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-[#f6f7fa] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">{bump.headline}</div>
                    <div className="truncate text-[10px] text-[#17213a]/45">
                      {byId.get(bump.primary_product_id)?.title || "Product"} →{" "}
                      {byId.get(bump.bump_product_id)?.title || "Add-on"}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Delete ${bump.headline}`}
                    onClick={() => removeBump.mutate(bump.id)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-red-500 hover:bg-red-50"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const style =
    status === "published" || status === "paid"
      ? "bg-emerald-500 text-white"
      : status === "partially_refunded"
        ? "bg-amber-100 text-amber-800"
        : status === "refunded"
          ? "bg-[#e9ebf0] text-[#17213a]/60"
          : status === "archived"
            ? "bg-[#17213a] text-white"
            : status === "failed" || status === "disputed"
              ? "bg-red-100 text-red-700"
              : "bg-[#ffc928] text-[#17213a]";
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[10px] font-semibold capitalize shadow-sm ${style}`}
    >
      {status}
    </span>
  );
}

function DeleteProductDialog({
  product,
  busy,
  onClose,
  onConfirm,
}: {
  product: CommerceProductRecord | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={Boolean(product)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md overflow-hidden rounded-[30px] border-0 bg-white p-0 shadow-2xl">
        <div className="bg-gradient-to-br from-red-50 via-white to-[#eef5ff] p-6 sm:p-7">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-red-100 text-red-600">
            <Trash2 className="size-5" />
          </div>
          <DialogTitle className="mt-5 font-ui-display text-3xl leading-tight text-[#17213a]">
            Delete {product?.title || "this item"}?
          </DialogTitle>
          <p className="mt-3 text-sm leading-6 text-[#17213a]/55">
            This removes its storefront blocks and attached setup. Items with orders cannot be
            deleted, so receipts and customer access always stay safe.
          </p>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded-2xl border border-black/[0.08] bg-white px-4 py-2.5 text-sm font-semibold text-[#17213a] disabled:opacity-50"
            >
              Keep it
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete permanently
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OrdersPanel({
  orders,
  products,
  totalOrders,
}: {
  orders: CommerceOrderRecord[];
  products: CommerceProductRecord[];
  totalOrders: number;
}) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const buyerAnswers = (order: CommerceOrderRecord) => {
    if (!Array.isArray(order.metadata?.buyer_answers)) return [];
    return order.metadata.buyer_answers.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const answer = value as Record<string, unknown>;
      return typeof answer.question === "string" && typeof answer.answer === "string"
        ? [{ question: answer.question, answer: answer.answer }]
        : [];
    });
  };
  if (!orders.length)
    return (
      <EmptyPanel
        icon={Inbox}
        title="No orders yet"
        body="Test a published product in this deployment to see the complete buyer and fee record here."
      />
    );
  return (
    <div className="overflow-hidden rounded-[30px] border border-black/[0.07] bg-white shadow-sm">
      {totalOrders > orders.length && (
        <div className="border-b border-black/[0.06] bg-[#f8f9fc] px-5 py-3 text-xs text-[#17213a]/52">
          Showing the latest {orders.length.toLocaleString()} of {totalOrders.toLocaleString()} paid
          orders.
        </div>
      )}
      <div className="grid gap-3 p-3 md:hidden">
        {orders.map((order) => {
          const refunded = Number(order.refunded_amount || 0);
          const netAfterRefund = Math.max(0, Number(order.net_amount || 0) - refunded);
          return (
            <article
              key={order.id}
              className="min-w-0 rounded-[24px] border border-black/[0.06] bg-[#f8f9fc] p-4"
            >
              <div className="flex min-w-0 items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-[#17213a]">
                    {byId.get(order.product_id)?.title || "Product"}
                  </div>
                  <div className="mt-1 truncate text-xs text-[#17213a]/48">
                    {order.buyer_name || "Customer"} · {order.buyer_email}
                  </div>
                </div>
                <StatusPill status={order.status} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <OrderMetric
                  label="Gross"
                  value={formatCommerceMoney(order.gross_amount, order.currency)}
                />
                <OrderMetric
                  label={refunded > 0 ? "Net after refund" : "Net"}
                  value={formatCommerceMoney(netAfterRefund, order.currency)}
                  accent
                />
                {refunded > 0 && (
                  <OrderMetric
                    label="Refunded"
                    value={`−${formatCommerceMoney(refunded, order.currency)}`}
                  />
                )}
                <OrderMetric label="Provider" value={commerceProviderLabel(order.provider)} />
              </div>
              {order.dispute_status && (
                <div className="mt-3 rounded-2xl border border-red-100 bg-red-50 px-3 py-2.5 text-xs text-red-700">
                  <span className="font-semibold">
                    Dispute {order.dispute_status.replaceAll("_", " ")}
                  </span>
                  {order.dispute_reason ? ` · ${order.dispute_reason}` : ""}
                </div>
              )}
              {buyerAnswers(order).length > 0 && (
                <div className="mt-3 space-y-2 rounded-2xl border border-black/[0.06] bg-white p-3">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#17213a]/35">
                    Buyer details
                  </div>
                  {buyerAnswers(order).map((answer, index) => (
                    <div key={`${index}-${answer.question}`} className="text-xs leading-5">
                      <div className="font-semibold text-[#17213a]/65">{answer.question}</div>
                      <div className="whitespace-pre-wrap break-words text-[#17213a]/50">
                        {answer.answer}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center justify-between gap-3 text-[10px] text-[#17213a]/40">
                <span className="font-mono">#{String(order.id).slice(0, 8)}</span>
                <time dateTime={order.paid_at || order.created_at}>
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(order.paid_at || order.created_at))}
                </time>
              </div>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="bg-[#f7f8fc] text-[10px] uppercase tracking-[0.15em] text-[#17213a]/45">
            <tr>
              <th className="px-5 py-4">Order</th>
              <th className="px-5 py-4">Customer</th>
              <th className="px-5 py-4">Product</th>
              <th className="px-5 py-4">Gross</th>
              <th className="px-5 py-4">Fees</th>
              <th className="px-5 py-4">Refunded</th>
              <th className="px-5 py-4">Net</th>
              <th className="px-5 py-4">Provider</th>
              <th className="px-5 py-4">Status</th>
              <th className="px-5 py-4">Dispute</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.06]">
            {orders.map((order) => (
              <tr key={order.id}>
                <td className="px-5 py-4 font-mono text-xs text-[#17213a]/45">
                  {String(order.id).slice(0, 8)}
                </td>
                <td className="px-5 py-4">
                  <div className="font-medium">{order.buyer_name || "Customer"}</div>
                  <div className="text-xs text-[#17213a]/45">{order.buyer_email}</div>
                </td>
                <td className="px-5 py-4 font-medium">
                  <div>{byId.get(order.product_id)?.title || "Product"}</div>
                  {buyerAnswers(order).length > 0 && (
                    <details className="mt-2 max-w-64 text-xs font-normal text-[#17213a]/55">
                      <summary className="cursor-pointer font-semibold text-[#17213a]/60">
                        Buyer details ({buyerAnswers(order).length})
                      </summary>
                      <div className="mt-2 space-y-2">
                        {buyerAnswers(order).map((answer, index) => (
                          <div key={`${index}-${answer.question}`}>
                            <div className="font-semibold">{answer.question}</div>
                            <div className="whitespace-pre-wrap break-words">{answer.answer}</div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </td>
                <td className="px-5 py-4">
                  {formatCommerceMoney(order.gross_amount, order.currency)}
                </td>
                <td className="px-5 py-4 text-[#17213a]/50">
                  −
                  {formatCommerceMoney(
                    Number(order.platform_fee_amount || 0) +
                      Number(order.processor_fee_amount || 0),
                    order.currency,
                  )}
                </td>
                <td className="px-5 py-4 text-[#17213a]/50">
                  {Number(order.refunded_amount || 0) > 0
                    ? `−${formatCommerceMoney(order.refunded_amount, order.currency)}`
                    : "-"}
                </td>
                <td className="px-5 py-4 font-semibold text-emerald-600">
                  {formatCommerceMoney(
                    Math.max(0, Number(order.net_amount || 0) - Number(order.refunded_amount || 0)),
                    order.currency,
                  )}
                </td>
                <td className="px-5 py-4 text-[#17213a]/55">
                  {commerceProviderLabel(order.provider)}
                </td>
                <td className="px-5 py-4">
                  <StatusPill status={order.status} />
                </td>
                <td className="max-w-52 px-5 py-4 text-xs text-[#17213a]/55">
                  {order.dispute_status ? (
                    <div>
                      <div className="font-semibold capitalize text-red-600">
                        {order.dispute_status.replaceAll("_", " ")}
                      </div>
                      {order.dispute_reason && (
                        <div className="mt-1 truncate" title={order.dispute_reason}>
                          {order.dispute_reason}
                        </div>
                      )}
                    </div>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OrderMetric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-2xl bg-white px-3 py-2.5">
      <div className="truncate text-[9px] font-semibold uppercase tracking-[0.12em] text-[#17213a]/35">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-sm font-semibold ${
          accent ? "text-emerald-600" : "text-[#17213a]"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function commerceProviderLabel(provider: string) {
  const labels: Record<string, string> = {
    stripe: "Stripe",
    dodo: "Dodo Payments",
    polar: "Polar",
    razorpay: "Razorpay",
    creem: "Creem",
    paypal: "PayPal",
    mock: "Test checkout",
  };
  return labels[String(provider || "").toLowerCase()] || provider || "Payment provider";
}

function StoreMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[24px] border border-black/[0.06] bg-white p-5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/35">
        {label}
      </div>
      <div className="mt-2 font-ui-display text-3xl tabular-nums">{value}</div>
    </div>
  );
}

function StoreAnalyticsPanel({ data }: { data: CommerceDashboardData | undefined }) {
  const stats = data?.stats;
  const sessions = data?.paymentSessions ?? [];
  const maxStep = Math.max(1, stats?.checkoutStarted ?? 0);
  const completed = stats?.checkoutCompleted ?? 0;
  const failed = stats?.checkoutFailed ?? 0;
  const moneyByCurrency = stats?.moneyByCurrency ?? [];
  const revenueLabel = formatMoneyBreakdown(moneyByCurrency, "revenue");
  const averageOrderLabel =
    moneyByCurrency.length === 1 && moneyByCurrency[0].orders > 0
      ? formatCommerceMoney(
          Math.round(moneyByCurrency[0].revenue / moneyByCurrency[0].orders),
          moneyByCurrency[0].currency,
        )
      : moneyByCurrency.length > 1
        ? "By currency"
        : formatCommerceMoney(0, "usd");
  const funnel = [
    { label: "Checkout started", value: stats?.checkoutStarted ?? 0, color: "#3478f6" },
    { label: "Payment completed", value: completed, color: "#24a56a" },
    { label: "Fulfilled orders", value: stats?.orders ?? 0, color: "#8067e8" },
  ];

  return (
    <div className="space-y-4">
      <section className="rounded-[30px] border border-black/[0.06] bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-ui-display text-3xl">Store analytics</h2>
            <p className="mt-1 text-sm text-[#17213a]/48">
              Checkout, conversion, revenue, promotions, and fulfillment from the same payment
              records.
            </p>
          </div>
          <div className="text-sm font-semibold text-emerald-600">
            {stats?.checkoutConversion ?? 0}% checkout conversion
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StoreMetric label="Revenue" value={revenueLabel} />
          <StoreMetric label="Paid orders" value={stats?.orders ?? 0} />
          <StoreMetric label="Average order" value={averageOrderLabel} />
          <StoreMetric label="Failed checkouts" value={failed} />
        </div>
        {moneyByCurrency.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {moneyByCurrency.map((total) => (
              <span
                key={total.currency}
                className="rounded-full bg-[#f1f4fa] px-3 py-1.5 text-xs font-semibold text-[#17213a]/62"
              >
                {formatCommerceMoney(total.revenue, total.currency)} revenue ·{" "}
                {total.orders.toLocaleString()} orders
              </span>
            ))}
          </div>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
        <section className="rounded-[30px] border border-black/[0.06] bg-white p-5 shadow-sm sm:p-6">
          <div className="font-semibold">Checkout funnel</div>
          <div className="mt-5 space-y-4">
            {funnel.map((step) => (
              <div key={step.label}>
                <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                  <span className="text-[#17213a]/55">{step.label}</span>
                  <span className="font-semibold tabular-nums">{step.value}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-[#eef0f5]">
                  <div
                    className="h-full min-w-0 rounded-full transition-[width]"
                    style={{
                      width: `${Math.max(0, Math.min(100, (step.value / maxStep) * 100))}%`,
                      background: step.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          {!sessions.length && (
            <p className="mt-5 rounded-2xl bg-[#f6f7fa] p-4 text-xs leading-5 text-[#17213a]/48">
              Funnel data appears after the first buyer starts checkout.
            </p>
          )}
        </section>
        <section className="rounded-[30px] border border-black/[0.06] bg-white p-5 shadow-sm sm:p-6">
          <div className="font-semibold">Growth impact</div>
          <div className="mt-4 space-y-3">
            <AnalyticsStat
              label="Discounted checkouts"
              value={stats?.discountedCheckouts ?? 0}
              tint="bg-[#fff0b8]"
            />
            <AnalyticsStat
              label="Order bumps accepted"
              value={stats?.bumpCheckouts ?? 0}
              tint="bg-[#e7f7ee]"
            />
            <AnalyticsStat
              label="Audience members"
              value={stats?.audience ?? 0}
              tint="bg-[#e9e1ff]"
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function AnalyticsStat({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div className={`flex items-center justify-between gap-3 rounded-2xl p-4 ${tint}`}>
      <span className="text-xs font-medium text-[#17213a]/60">{label}</span>
      <span className="font-ui-display text-2xl tabular-nums">{value}</span>
    </div>
  );
}

function PayoutsPanel({ data }: { data: CommerceDashboardData | undefined }) {
  const fee = "0%";
  const moneyByCurrency = data?.stats.moneyByCurrency ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-[30px] bg-[#17213a] p-6 text-white lg:col-span-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">
          Net sales recorded
        </div>
        <div className="mt-3 font-ui-display text-5xl">
          {formatMoneyBreakdown(moneyByCurrency, "net")}
        </div>
        {moneyByCurrency.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {moneyByCurrency.map((total) => (
              <span
                key={total.currency}
                className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/72"
              >
                {formatCommerceMoney(total.net, total.currency)}
              </span>
            ))}
          </div>
        )}
        <p className="mt-3 max-w-xl text-sm leading-6 text-white/50">
          The application never holds this money. Sales settle directly into your connected payment
          provider, which remains the source of truth for available balance, payout timing, taxes,
          disputes, and withdrawals.
        </p>
        <div className="mt-6 inline-flex rounded-2xl bg-white/10 px-5 py-3 text-sm font-semibold text-white/70">
          Manage payouts with your payment provider
        </div>
      </div>
      <div className="rounded-[30px] border border-black/[0.07] bg-[#dceaff] p-6">
        <BadgePercent className="size-6 text-[#3478f6]" />
        <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#245fd0]/60">
          Your platform fee
        </div>
        <div className="mt-1 font-ui-display text-4xl text-[#245fd0]">{fee}</div>
        <p className="mt-3 text-sm leading-6 text-[#245fd0]/65">
          Payment gateway fees are shown separately on every order. No hidden deduction is folded
          into this rate.
        </p>
      </div>
    </div>
  );
}

function formatMoneyBreakdown<T extends { currency: string }>(
  totals: T[],
  field: keyof T = "revenue" as keyof T,
) {
  if (!totals.length) return formatCommerceMoney(0, "usd");
  const formatted = totals.map((total) =>
    formatCommerceMoney(Math.max(0, Number(total[field] || 0)), total.currency),
  );
  if (formatted.length <= 2) return formatted.join(" + ");
  return `${formatted.length} currencies`;
}

function EmptyPanel({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Inbox;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-[30px] border border-dashed border-black/[0.12] bg-white p-10 text-center">
      <Icon className="mx-auto size-7 text-[#3478f6]" />
      <h3 className="mt-4 font-ui-display text-2xl">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#17213a]/48">{body}</p>
    </div>
  );
}

function ProductKindPicker({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (kind: CommerceProductKind) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86dvh] w-[calc(100vw-1.5rem)] max-w-4xl overflow-y-auto rounded-[32px] border-white/80 bg-white/92 p-5 shadow-[0_40px_120px_-44px_rgba(23,33,58,.65)] backdrop-blur-2xl sm:p-7">
        <DialogTitle className="font-ui-display text-3xl">What do you want to sell?</DialogTitle>
        <p className="-mt-2 text-sm text-[#17213a]/50">
          Pick an offer type for its dedicated setup, hosted page, checkout, and delivery flow. Lead
          forms and affiliate links now live in the Grow tab.
        </p>
        <section className="mt-6">
          <h3 className="font-sans text-sm font-semibold">Sell</h3>
          <p className="mt-0.5 text-xs text-[#17213a]/42">
            Products, services, learning, events, and paid access.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COMMERCE_KINDS.filter(
              (definition) => definition.family === "sell" && definition.kind !== "newsletter",
            ).map((definition) => {
              const Icon = PRODUCT_ICONS[definition.kind];
              return (
                <button
                  key={definition.kind}
                  type="button"
                  onClick={() => onChoose(definition.kind)}
                  className="group rounded-[24px] border border-black/[0.07] bg-[#f8faff] p-4 text-left transition hover:-translate-y-1 hover:border-[#3478f6]/30 hover:bg-[#eef5ff] hover:shadow-lg"
                >
                  <div className="flex items-start justify-between">
                    <span
                      className="flex size-11 items-center justify-center rounded-2xl text-white"
                      style={{ background: definition.accent }}
                    >
                      <Icon className="size-5" />
                    </span>
                    <ChevronRight className="size-4 text-[#17213a]/25 transition group-hover:translate-x-0.5" />
                  </div>
                  <div className="mt-4 font-ui-display text-xl">{definition.label}</div>
                  <p className="mt-1 text-xs leading-5 text-[#17213a]/48">
                    {definition.description}
                  </p>
                </button>
              );
            })}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

type ProductDraft = {
  kind: CommerceProductKind;
  title: string;
  subtitle: string;
  description: string;
  cover_url: string | null;
  pricing_type: CommercePricingType;
  price_amount: number;
  currency: string;
  billing_interval: "day" | "week" | "month" | "year" | null;
  cta_label: string;
  settings: CommerceProductSettings;
  inventory_limit: number | null;
  noindex: boolean;
};

const STORE_TEMPLATE_DRAFTS: Partial<
  Record<CommerceProductKind, Pick<ProductDraft, "title" | "subtitle" | "description">>
> = {
  digital_product: {
    title: "My digital download",
    subtitle: "A practical resource your buyer can use right away.",
    description:
      "Explain what is included, who it is for, and the result this download helps the buyer achieve.",
  },
  course: {
    title: "My mini course",
    subtitle: "A clear path from idea to outcome.",
    description:
      "Outline what students will learn, how the lessons are delivered, and the result they can expect.",
  },
  webinar: {
    title: "My live workshop",
    subtitle: "Learn with me in a focused live session.",
    description:
      "Share the topic, who should attend, the agenda, and what participants will leave with.",
  },
  paid_community: {
    title: "My community",
    subtitle: "A focused space to learn and grow together.",
    description:
      "Explain who the community is for, what members receive, and how often you will show up.",
  },
  membership: {
    title: "My membership",
    subtitle: "Ongoing access to resources and support.",
    description:
      "Describe the recurring benefits, new content cadence, and what members can expect each month.",
  },
  priority_dm: {
    title: "Priority message",
    subtitle: "Send me a paid message and move to the front of my inbox.",
    description:
      "Share what you need help with and I will reply within the promised response time.",
  },
  bundle: {
    title: "Creator bundle",
    subtitle: "Get several of my best products in one purchase.",
    description: "A curated collection of downloads, courses, and resources sold together.",
  },
};

function draftFor(
  kind: CommerceProductKind,
  existing?: CommerceProductRecord,
  bookingAvailability?: Availability,
): ProductDraft {
  const definition = commerceKind(kind);
  if (existing) {
    const settings = { ...(existing.settings || {}) };
    const detectedTimeZone = browserTimeZone();
    if (
      kind === "coaching_call" &&
      !Array.isArray(settings.weeklyRules) &&
      !Array.isArray(settings.availabilityDays)
    ) {
      Object.assign(
        settings,
        bookingAvailabilitySettings(bookingAvailability || DEFAULT_AVAILABILITY),
      );
    }
    if (kind === "webinar") settings.timezone = detectedTimeZone;
    if (kind === "webinar" && settings.startsAt) {
      settings.startsAt = isoToZonedDateTimeInput(String(settings.startsAt), detectedTimeZone);
    }
    if (kind === "priority_dm") {
      settings.freeFollowUpLimit ??= 0;
      settings.followUpPriceAmount ??= existing.price_amount;
    }
    return {
      kind,
      title: existing.title || "",
      subtitle: existing.subtitle || "",
      description: existing.description || "",
      cover_url: existing.cover_url || null,
      pricing_type: existing.pricing_type,
      price_amount: Number(existing.price_amount || 0),
      currency: existing.currency || "usd",
      billing_interval: existing.billing_interval || null,
      cta_label: existing.cta_label || definition.defaultCta,
      settings,
      inventory_limit: existing.inventory_limit || null,
      noindex: existing.noindex ?? true,
    };
  }
  const settings: CommerceProductSettings = {};
  if (kind === "digital_product") settings.files = [];
  if (kind === "coaching_call")
    Object.assign(settings, {
      durationMinutes: 60,
      ...bookingAvailabilitySettings(bookingAvailability || DEFAULT_AVAILABILITY),
      availabilitySummary: "Uses your Calendar availability",
      recordingAddonEnabled: false,
      recordingAddonPrice: 1900,
    });
  if (kind === "course") settings.lessons = [];
  if (kind === "webinar")
    Object.assign(settings, {
      startsAt: "",
      timezone: browserTimeZone(),
      durationMinutes: 60,
      joinUrl: "",
      replayUrl: "",
    });
  if (kind === "paid_community")
    Object.assign(settings, { welcomeMessage: "", rules: "Be kind. Share generously." });
  if (kind === "membership") settings.benefits = ["Member-only updates"];
  if (kind === "custom_product")
    Object.assign(settings, { fulfillmentInstructions: "", buyerQuestions: [] });
  if (kind === "priority_dm")
    Object.assign(settings, {
      priorityPrompt: "What would you like to ask?",
      responseTimeHours: 48,
      freeFollowUpLimit: 1,
      followUpPriceAmount: 1900,
    });
  if (kind === "bundle") settings.bundledProductIds = [];
  if (kind === "lead_form")
    Object.assign(settings, {
      fields: [{ id: "email", label: "Email", type: "email", required: true }],
      confirmationMessage: "You're in. Thank you.",
    });
  const template = STORE_TEMPLATE_DRAFTS[kind];
  return {
    kind,
    title: template?.title || "",
    subtitle: template?.subtitle || "",
    description: template?.description || "",
    cover_url: null,
    pricing_type: definition.defaultPricing,
    price_amount: definition.defaultPricing === "free" ? 0 : 1900,
    currency: "usd",
    billing_interval: definition.defaultPricing === "subscription" ? "month" : null,
    cta_label: definition.defaultCta,
    settings,
    inventory_limit: null,
    noindex: true,
  };
}

function productDraftForSave(draft: ProductDraft): ProductDraft {
  if (draft.kind !== "webinar" || !draft.settings.startsAt) return draft;
  const startsAt = zonedDateTimeInputToIso(
    String(draft.settings.startsAt),
    String(draft.settings.timezone || ""),
  );
  if (!startsAt) return draft;
  return {
    ...draft,
    settings: {
      ...draft.settings,
      startsAt,
    },
  };
}

function GrowthActionBuilder({
  open,
  kind,
  action,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  kind?: CommerceProductKind;
  action?: CommerceProductRecord;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const growthKind = kind && isCommerceGrowthKind(kind) ? kind : undefined;
  const initialKey = `${growthKind}:${action?.id ?? "new"}`;
  const [draft, setDraft] = useState<ProductDraft | null>(() =>
    growthKind ? draftFor(growthKind, action) : null,
  );
  useEffect(() => {
    setDraft(growthKind ? draftFor(growthKind, action) : null);
  }, [initialKey, growthKind, action]);
  const definition = growthKind ? commerceKind(growthKind) : null;
  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Growth action is not ready.");
      return action
        ? updateCommerceProduct({ data: { id: action.id, product: draft } })
        : createCommerceProduct({ data: { product: draft, addToBento: true, pageId: null } });
    },
    onSuccess: () => {
      toast.success(action ? "Growth action saved" : "Growth action and block created");
      onSaved();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save growth action"),
  });
  if (!draft || !definition) return null;

  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  const setSetting = <K extends keyof CommerceProductSettings>(
    key: K,
    value: CommerceProductSettings[K],
  ) => set("settings", { ...draft.settings, [key]: value });
  const Icon = PRODUCT_ICONS[draft.kind];
  const isLeadForm = draft.kind === "lead_form";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-4xl gap-0 overflow-hidden rounded-[24px] border-white/80 bg-[#f7f8fc] p-0 shadow-[0_42px_130px_-45px_rgba(23,33,58,.7)] sm:h-[min(92dvh,820px)] sm:rounded-[32px] [&>button]:z-40">
        <DialogTitle className="sr-only">
          {action ? "Edit" : "Create"} {definition.label}
        </DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
          className="flex size-full min-h-0 flex-col"
        >
          <div className="flex min-w-0 items-center gap-3 border-b border-black/[0.06] bg-white px-4 py-3 pr-14 sm:px-7 sm:py-4">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-2xl text-white"
              style={{ background: definition.accent }}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-ui-display text-lg sm:text-xl">
                {action ? "Edit" : "Create"} {definition.label.toLowerCase()}
              </div>
              <div className="text-xs text-[#17213a]/45">
                A simple growth action with no pricing, checkout, or product delivery.
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
            <div className="mx-auto max-w-2xl space-y-6">
              <FormSection eyebrow="Basics" title="Say what visitors should do">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Title">
                    <input
                      autoFocus
                      required
                      value={draft.title}
                      onChange={(event) => set("title", event.target.value)}
                      className={inputClass}
                      placeholder={
                        isLeadForm ? "Join my email list" : "Build your page with my link"
                      }
                    />
                  </Field>
                  <Field label="Short line">
                    <input
                      value={draft.subtitle}
                      onChange={(event) => set("subtitle", event.target.value)}
                      className={inputClass}
                      placeholder={
                        isLeadForm ? "What will subscribers receive?" : "Why should they click?"
                      }
                    />
                  </Field>
                </div>
                <Field label="Description">
                  <textarea
                    required
                    value={draft.description}
                    onChange={(event) => set("description", event.target.value)}
                    className={`${inputClass} min-h-28 resize-y`}
                    placeholder={
                      isLeadForm
                        ? "Explain what you collect and what happens after submission."
                        : "Share a concise reason to create a page through your referral link."
                    }
                  />
                </Field>
              </FormSection>

              <SpecificProductFields draft={draft} setSetting={setSetting} />

              <FormSection eyebrow="Block" title="Finish the action">
                <Field label="Button label">
                  <input
                    required
                    value={draft.cta_label}
                    onChange={(event) => set("cta_label", event.target.value)}
                    className={inputClass}
                    placeholder={definition.defaultCta}
                  />
                </Field>
                <div className="rounded-2xl bg-[#ece7ff] px-4 py-3 text-xs leading-5 text-[#654bb0]">
                  The application publishes this action and adds its matching block as soon as you
                  create it.
                </div>
              </FormSection>
            </div>
          </div>

          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-t border-black/[0.06] bg-white px-4 py-3 sm:flex sm:justify-between sm:gap-3 sm:px-8 sm:py-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-2xl px-4 py-2.5 text-sm font-semibold text-[#17213a]/55 hover:bg-[#f2f5fb]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={save.isPending || !draft.title.trim() || !draft.description.trim()}
              className="inline-flex min-w-0 items-center justify-center gap-2 rounded-2xl bg-[#8067e8] px-3 py-3 text-sm font-semibold text-white disabled:opacity-50 sm:px-5"
            >
              {save.isPending && <Loader2 className="size-4 animate-spin" />}
              {action ? "Save changes" : "Create action + block"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProductBuilder({
  open,
  kind,
  product,
  profile,
  bookingAvailability,
  bookingAvailabilityLoading,
  products,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  kind?: CommerceProductKind;
  product?: CommerceProductRecord;
  profile?: {
    theme?: string | null;
    accent_color?: string | null;
  } | null;
  bookingAvailability?: Availability;
  bookingAvailabilityLoading?: boolean;
  products: CommerceProductRecord[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const initialKey = `${kind}:${product?.id ?? "new"}`;
  const [draft, setDraft] = useState<ProductDraft | null>(() =>
    kind ? draftFor(kind, product, bookingAvailability) : null,
  );
  const [stepIndex, setStepIndex] = useState(0);
  useEffect(() => {
    if (kind === "coaching_call" && bookingAvailabilityLoading) return;
    setDraft(kind ? draftFor(kind, product, bookingAvailability) : null);
    setStepIndex(0);
  }, [initialKey, kind, product, bookingAvailability, bookingAvailabilityLoading]);
  const definition = kind ? commerceKind(kind) : null;
  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("Product is not ready.");
      const productDraft = productDraftForSave(draft);
      return product
        ? updateCommerceProduct({ data: { id: product.id, product: productDraft } })
        : createCommerceProduct({
            data: { product: productDraft, addToBento: true, pageId: null },
          });
    },
    onSuccess: () => {
      toast.success(product ? "Product saved" : "Product published and block created");
      onSaved();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save product"),
  });
  if (!draft || !definition || (kind === "coaching_call" && bookingAvailabilityLoading)) {
    return null;
  }
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  const setSetting = <K extends keyof CommerceProductSettings>(
    key: K,
    value: CommerceProductSettings[K],
  ) => set("settings", { ...draft.settings, [key]: value });
  const paid = !["lead_form", "bento_affiliate"].includes(draft.kind);
  const steps = productBuilderSteps(paid);
  const activeStepIndex = clampProductBuilderStep(stepIndex, steps.length);
  const activeStep = steps[activeStepIndex];
  const isLastStep = activeStepIndex === steps.length - 1;
  const canContinue =
    activeStep.id === "basics"
      ? Boolean(draft.title.trim() && draft.description.trim())
      : activeStep.id === "page"
        ? Boolean(draft.cta_label.trim())
        : true;
  const canSave = Boolean(draft.title.trim() && draft.description.trim() && draft.cta_label.trim());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-6xl gap-0 overflow-hidden rounded-[24px] border-white/80 bg-[#f7f8fc] p-0 shadow-[0_42px_130px_-45px_rgba(23,33,58,.7)] sm:h-[min(92dvh,860px)] sm:rounded-[32px] [&>button]:z-40">
        <DialogTitle className="sr-only">
          {product ? "Edit" : "Create"} {definition.label}
        </DialogTitle>
        <div className="grid size-full min-h-0 overflow-hidden rounded-[22px] sm:rounded-[30px] lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="relative hidden overflow-hidden rounded-l-[30px] bg-[#17213a] p-7 text-white lg:flex lg:flex-col">
            <div
              className="absolute -right-24 -top-20 size-56 rounded-full blur-2xl"
              style={{ background: `${definition.accent}66` }}
            />
            <div className="relative text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35">
              Product builder · Step {activeStepIndex + 1} of {steps.length}
            </div>
            <h2 className="relative mt-2 font-ui-display text-4xl leading-[1.02]">
              {definition.label}
            </h2>
            <p className="relative mt-3 text-sm leading-6 text-white/50">{definition.setupHint}</p>
            <div className="relative mt-auto">
              <ProductBlockPreview
                product={{ ...draft, id: product?.id, slug: product?.slug }}
                profile={profile ?? undefined}
                compact
              />
            </div>
          </aside>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!isLastStep) {
                if (canContinue) setStepIndex((current) => current + 1);
                return;
              }
              save.mutate();
            }}
            className="flex min-h-0 flex-col overflow-hidden rounded-r-[30px]"
          >
            <div className="flex min-w-0 items-center gap-3 border-b border-black/[0.06] bg-white px-4 py-3 pr-14 sm:px-7 sm:py-4">
              <span
                className="flex size-10 items-center justify-center rounded-2xl text-white lg:hidden"
                style={{ background: definition.accent }}
              >
                {(() => {
                  const Icon = PRODUCT_ICONS[draft.kind];
                  return <Icon className="size-4" />;
                })()}
              </span>
              <div className="min-w-0">
                <div className="truncate font-ui-display text-lg sm:text-xl">
                  {product ? "Edit" : "Create"} {definition.label.toLowerCase()}
                </div>
                <div className="text-xs text-[#17213a]/45">
                  Step {activeStepIndex + 1} of {steps.length} · {activeStep.title}
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
              <div className="mx-auto max-w-3xl space-y-6">
                {activeStep.id === "page" && (
                  <div className="lg:hidden">
                    <ProductBlockPreview
                      product={{ ...draft, id: product?.id, slug: product?.slug }}
                      profile={profile ?? undefined}
                    />
                  </div>
                )}
                {activeStep.id === "basics" && (
                  <FormSection eyebrow="Basics" title="Make the offer clear">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Title">
                        <input
                          autoFocus
                          required
                          maxLength={120}
                          value={draft.title}
                          onChange={(event) => set("title", event.target.value)}
                          className={inputClass}
                          placeholder={definition.label}
                        />
                      </Field>
                      <Field label="Short line">
                        <input
                          maxLength={180}
                          value={draft.subtitle}
                          onChange={(event) => set("subtitle", event.target.value)}
                          className={inputClass}
                          placeholder="What makes it worth clicking?"
                        />
                      </Field>
                    </div>
                    <Field label="Description">
                      <textarea
                        required
                        maxLength={20_000}
                        value={draft.description}
                        onChange={(event) => set("description", event.target.value)}
                        className={`${inputClass} min-h-32 resize-y`}
                        placeholder="Tell buyers exactly what they get and who it is for."
                      />
                    </Field>
                    <FileDropzone
                      kind="cover"
                      value={draft.cover_url || ""}
                      onChange={(url) => set("cover_url", url || null)}
                      label="Product cover"
                      className="max-w-sm"
                    />
                  </FormSection>
                )}

                {activeStep.id === "pricing" && paid && (
                  <FormSection eyebrow="Price" title="Choose how people pay">
                    <div className="grid gap-4 sm:grid-cols-3">
                      <Field label="Pricing">
                        <select
                          value={draft.pricing_type}
                          onChange={(event) => {
                            const next = event.target.value as CommercePricingType;
                            setDraft({
                              ...draft,
                              pricing_type: next,
                              price_amount: next === "free" ? 0 : Math.max(draft.price_amount, 100),
                              billing_interval:
                                next === "subscription" ? draft.billing_interval || "month" : null,
                            });
                          }}
                          className={inputClass}
                        >
                          <option value="one_time">One-time</option>
                          <option value="subscription">Recurring</option>
                          <option value="free">Free</option>
                        </select>
                      </Field>
                      <Field label="Price">
                        <PriceInput
                          amount={draft.price_amount}
                          disabled={draft.pricing_type === "free"}
                          onAmountChange={(amount) => set("price_amount", amount)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Currency">
                        <select
                          value={draft.currency}
                          onChange={(event) => set("currency", event.target.value)}
                          className={inputClass}
                        >
                          <option value="usd">USD</option>
                          <option value="inr">INR</option>
                          <option value="eur">EUR</option>
                          <option value="gbp">GBP</option>
                          <option value="aud">AUD</option>
                          <option value="cad">CAD</option>
                        </select>
                      </Field>
                    </div>
                    {draft.pricing_type === "subscription" && (
                      <Field label="Renews every">
                        <select
                          value={draft.billing_interval || "month"}
                          onChange={(event) =>
                            set(
                              "billing_interval",
                              event.target.value as ProductDraft["billing_interval"],
                            )
                          }
                          className={inputClass}
                        >
                          <option value="day">Day</option>
                          <option value="week">Week</option>
                          <option value="month">Month</option>
                          <option value="year">Year</option>
                        </select>
                      </Field>
                    )}
                    <div className="rounded-2xl bg-[#dceaff] px-4 py-3 text-xs leading-5 text-[#245fd0]">
                      Platform fee: 0% on every plan. Your payment provider’s processing or
                      merchant-of-record fees remain separate.
                    </div>
                  </FormSection>
                )}

                {activeStep.id === "details" && (
                  <SpecificProductFields
                    draft={draft}
                    setSetting={setSetting}
                    products={products}
                    currentProductId={product?.id}
                  />
                )}

                {activeStep.id === "page" && (
                  <FormSection eyebrow="Page" title="Finish the call to action">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Button label">
                        <input
                          required
                          maxLength={40}
                          value={draft.cta_label}
                          onChange={(event) => set("cta_label", event.target.value)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Inventory limit (optional)">
                        <input
                          type="number"
                          min="1"
                          max="1000000"
                          value={draft.inventory_limit ?? ""}
                          onChange={(event) =>
                            set(
                              "inventory_limit",
                              event.target.value ? Number(event.target.value) : null,
                            )
                          }
                          className={inputClass}
                          placeholder="Unlimited"
                        />
                      </Field>
                    </div>
                    <div className="flex items-start justify-between gap-6 rounded-2xl border border-black/[0.07] bg-[#f8faff] p-4">
                      <div>
                        <div className="text-sm font-semibold text-[#17213a]">
                          Show in search engines
                        </div>
                        <p className="mt-1 text-xs leading-5 text-[#17213a]/52">
                          Allow Google and other search engines to index this product page.
                        </p>
                      </div>
                      <Switch
                        aria-label="Show this product in search engines"
                        checked={!draft.noindex}
                        onCheckedChange={(showInSearch) => set("noindex", !showInSearch)}
                      />
                    </div>
                  </FormSection>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-black/[0.06] bg-white px-4 py-3 sm:px-8 sm:py-4">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-semibold text-[#17213a]/55 hover:bg-[#f2f5fb]"
              >
                Cancel
              </button>
              <div className="flex items-center gap-2">
                <span className="hidden text-xs font-semibold text-[#17213a]/35 sm:block">
                  {activeStepIndex + 1} / {steps.length}
                </span>
                <button
                  type="button"
                  disabled={activeStepIndex === 0}
                  onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
                  aria-label="Previous step"
                  className="inline-flex size-10 items-center justify-center rounded-lg border border-black/[0.07] bg-[#f2f5fb] text-[#17213a]/60 transition-colors hover:bg-[#e8eef9] disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="submit"
                  disabled={save.isPending || (isLastStep ? !canSave : !canContinue)}
                  className="inline-flex min-w-28 items-center justify-center gap-2 rounded-lg bg-[#3478f6] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#2168e5] disabled:opacity-50"
                >
                  {save.isPending && <Loader2 className="size-4 animate-spin" />}
                  {isLastStep ? (product ? "Save changes" : "Create product") : "Next"}
                  {!isLastStep && <ChevronRight className="size-4" />}
                </button>
              </div>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const inputClass =
  "w-full rounded-2xl border border-black/[0.07] bg-white px-4 py-3 text-sm text-[#17213a] outline-none transition placeholder:text-[#17213a]/28 focus:border-[#3478f6]/45 focus:ring-4 focus:ring-[#3478f6]/10 disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function FormSection({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-black/[0.06] bg-white p-5 shadow-[0_20px_50px_-45px_rgba(23,33,58,.5)] sm:p-6">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3478f6]">
        {eyebrow}
      </div>
      <h3 className="mt-1 font-ui-display text-2xl">{title}</h3>
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-[#17213a]/55">{label}</span>
      {children}
    </label>
  );
}

function coachingRules(settings: CommerceProductSettings): WeeklyRule[] {
  if (Array.isArray(settings.weeklyRules)) return settings.weeklyRules;
  return (settings.availabilityDays || []).map((day) => ({
    day,
    start: settings.availabilityStart || "09:00",
    end: settings.availabilityEnd || "17:00",
  }));
}

function SpecificProductFields({
  draft,
  setSetting,
  products = [],
  currentProductId,
}: {
  draft: ProductDraft;
  products?: CommerceProductRecord[];
  currentProductId?: string;
  setSetting: <K extends keyof CommerceProductSettings>(
    key: K,
    value: CommerceProductSettings[K],
  ) => void;
}) {
  if (draft.kind === "digital_product")
    return (
      <FormSection eyebrow="Delivery" title="Upload what buyers receive">
        <ProductAssetUploader
          files={draft.settings.files || []}
          onChange={(files) => setSetting("files", files)}
        />
      </FormSection>
    );
  if (draft.kind === "coaching_call")
    return (
      <FormSection eyebrow="Booking" title="Set the call details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Duration (minutes)">
            <input
              type="number"
              min="10"
              value={draft.settings.durationMinutes || 60}
              onChange={(e) => setSetting("durationMinutes", Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Available days">
          <div className="flex flex-wrap gap-2">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => {
              const rules = coachingRules(draft.settings);
              const selected = rules.some((rule) => rule.day === day);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    const firstRule = rules[0];
                    setSetting(
                      "weeklyRules",
                      selected
                        ? rules.filter((rule) => rule.day !== day)
                        : [
                            ...rules,
                            {
                              day,
                              start: firstRule?.start || "09:00",
                              end: firstRule?.end || "17:00",
                            },
                          ].sort((left, right) => left.day - right.day),
                    );
                  }}
                  className={`rounded-xl px-3 py-2 text-xs font-semibold transition ${
                    selected
                      ? "bg-[#3478f6] text-white"
                      : "border border-black/[0.07] bg-[#f7f8fc] text-[#17213a]/50"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="From">
            <input
              type="time"
              value={coachingRules(draft.settings)[0]?.start || "09:00"}
              onChange={(e) =>
                setSetting(
                  "weeklyRules",
                  coachingRules(draft.settings).map((rule) => ({
                    ...rule,
                    start: e.target.value,
                  })),
                )
              }
              className={inputClass}
            />
          </Field>
          <Field label="Until">
            <input
              type="time"
              value={coachingRules(draft.settings)[0]?.end || "17:00"}
              onChange={(e) =>
                setSetting(
                  "weeklyRules",
                  coachingRules(draft.settings).map((rule) => ({
                    ...rule,
                    end: e.target.value,
                  })),
                )
              }
              className={inputClass}
            />
          </Field>
          <Field label="Slot spacing">
            <select
              value={draft.settings.slotIntervalMinutes || 30}
              onChange={(e) => setSetting("slotIntervalMinutes", Number(e.target.value))}
              className={inputClass}
            >
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">60 minutes</option>
            </select>
          </Field>
        </div>
        <Field label="Availability">
          <textarea
            value={draft.settings.availabilitySummary || ""}
            onChange={(e) => setSetting("availabilitySummary", e.target.value)}
            className={`${inputClass} min-h-24`}
            placeholder="Mon–Thu, 10am–4pm. Exact slots are selected after purchase."
          />
        </Field>
        <div className="rounded-2xl border border-black/[0.07] bg-[#f7f8fc] p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={Boolean(draft.settings.recordingAddonEnabled)}
              onChange={(e) => setSetting("recordingAddonEnabled", e.target.checked)}
              className="mt-1 size-4 accent-[#3478f6]"
            />
            <span>
              <span className="block text-sm font-semibold">Offer a Fathom recording</span>
              <span className="mt-1 block text-xs leading-5 text-[#17213a]/48">
                Customers can add the private call recording during checkout.{" "}
                <Link
                  to="/settings"
                  search={{ section: "integrations", integration: "bookings" }}
                  className="font-semibold text-[#3478f6]"
                >
                  Connect Fathom in Settings
                </Link>{" "}
                before enabling this on a live session.
              </span>
            </span>
          </label>
          {draft.settings.recordingAddonEnabled && (
            <div className="mt-4 max-w-xs">
              <Field label="Recording price">
                <PriceInput
                  amount={Number(draft.settings.recordingAddonPrice || 0)}
                  onAmountChange={(amount) => setSetting("recordingAddonPrice", amount)}
                />
              </Field>
            </div>
          )}
        </div>
        <Field label="Fallback meeting link (optional)">
          <input
            value={draft.settings.meetingUrl || ""}
            onChange={(e) => setSetting("meetingUrl", e.target.value)}
            className={inputClass}
            placeholder="https://meet.google.com/..."
          />
        </Field>
      </FormSection>
    );
  if (draft.kind === "course")
    return (
      <FormSection eyebrow="Course" title="Build the first lessons">
        <CourseLessonEditor
          lessons={draft.settings.lessons || []}
          onChange={(lessons) => setSetting("lessons", lessons)}
        />
      </FormSection>
    );
  if (draft.kind === "webinar")
    return (
      <FormSection eyebrow="Event" title="Set the live experience">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts at">
            <input
              type="datetime-local"
              value={draft.settings.startsAt || ""}
              onChange={(e) => setSetting("startsAt", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="max-w-xs">
          <Field label="Duration (minutes)">
            <input
              type="number"
              min="10"
              max="480"
              value={draft.settings.durationMinutes || 60}
              onChange={(e) => setSetting("durationMinutes", Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Private join link">
          <input
            value={draft.settings.joinUrl || ""}
            onChange={(e) => setSetting("joinUrl", e.target.value)}
            className={inputClass}
            placeholder="Revealed only to paid attendees"
          />
        </Field>
        <Field label="Replay link (optional)">
          <input
            value={draft.settings.replayUrl || ""}
            onChange={(e) => setSetting("replayUrl", e.target.value)}
            className={inputClass}
          />
        </Field>
      </FormSection>
    );
  if (draft.kind === "paid_community")
    return (
      <FormSection eyebrow="Community" title="Welcome paying members">
        <Field label="Welcome message">
          <textarea
            value={draft.settings.welcomeMessage || ""}
            onChange={(e) => setSetting("welcomeMessage", e.target.value)}
            className={`${inputClass} min-h-28`}
            placeholder="What members will find inside"
          />
        </Field>
        <Field label="Community rules">
          <textarea
            value={draft.settings.rules || ""}
            onChange={(e) => setSetting("rules", e.target.value)}
            className={`${inputClass} min-h-24`}
          />
        </Field>
      </FormSection>
    );
  if (draft.kind === "membership")
    return (
      <FormSection eyebrow="Membership" title="Make the recurring value obvious">
        <ListEditor
          values={draft.settings.benefits || []}
          onChange={(values) => setSetting("benefits", values)}
          placeholder="Member benefit"
          addLabel="Add benefit"
        />
      </FormSection>
    );
  if (draft.kind === "custom_product")
    return (
      <FormSection eyebrow="Fulfilment" title="Explain what happens next">
        <Field label="Fulfilment instructions">
          <textarea
            value={draft.settings.fulfillmentInstructions || ""}
            onChange={(e) => setSetting("fulfillmentInstructions", e.target.value)}
            className={`${inputClass} min-h-28`}
            placeholder="For example: delivery within five business days by email."
          />
        </Field>
        <ListEditor
          values={draft.settings.buyerQuestions || []}
          onChange={(values) => setSetting("buyerQuestions", values)}
          placeholder="Question for the buyer"
          addLabel="Add question"
        />
      </FormSection>
    );
  if (draft.kind === "priority_dm")
    return (
      <FormSection eyebrow="Priority inbox" title="Set the reply promise">
        <Field label="Message prompt">
          <input
            maxLength={500}
            value={draft.settings.priorityPrompt || ""}
            onChange={(event) => setSetting("priorityPrompt", event.target.value)}
            className={inputClass}
            placeholder="What would you like to ask?"
          />
        </Field>
        <Field label="Reply within (hours)">
          <input
            type="number"
            min="1"
            max="720"
            required
            value={draft.settings.responseTimeHours || 48}
            onChange={(event) => setSetting("responseTimeHours", Number(event.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Included free buyer follow-ups">
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={draft.settings.freeFollowUpLimit ?? 0}
            onChange={(event) => setSetting("freeFollowUpLimit", Number(event.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Paid follow-up price">
          <PriceInput
            amount={draft.settings.followUpPriceAmount ?? draft.price_amount}
            ariaLabel="Paid follow-up price"
            onAmountChange={(amount) => setSetting("followUpPriceAmount", amount)}
            className={inputClass}
          />
        </Field>
        <div className="rounded-2xl bg-[#eef5ff] px-4 py-3 text-xs leading-5 text-[#245fd0]">
          Paid requests appear in your standalone Priority DM inbox. Email notifications let you
          reply directly, or reply from the application and the buyer receives your response by
          email.
        </div>
      </FormSection>
    );
  if (draft.kind === "bundle") {
    const eligibleProducts = products.filter(
      (product) =>
        product.status === "published" &&
        product.id !== currentProductId &&
        ["digital_product", "course", "custom_product"].includes(product.kind),
    );
    const selected = new Set(draft.settings.bundledProductIds || []);
    return (
      <FormSection eyebrow="Bundle" title="Choose included products">
        {eligibleProducts.length ? (
          <div className="space-y-2">
            {eligibleProducts.map((product) => (
              <label
                key={product.id}
                className="flex cursor-pointer items-center gap-3 rounded-2xl border border-black/[0.07] bg-[#f8faff] p-4"
              >
                <input
                  type="checkbox"
                  checked={selected.has(product.id)}
                  onChange={(event) =>
                    setSetting(
                      "bundledProductIds",
                      event.target.checked
                        ? [...selected, product.id]
                        : [...selected].filter((id) => id !== product.id),
                    )
                  }
                  className="size-4 accent-[#3478f6]"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{product.title}</span>
                  <span className="text-xs text-[#17213a]/45">
                    {commerceKind(product.kind).label}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm leading-6 text-[#17213a]/50">
            Publish at least two downloads, courses, or custom products before creating a bundle.
          </p>
        )}
      </FormSection>
    );
  }
  if (draft.kind === "lead_form")
    return (
      <FormSection eyebrow="Form" title="Choose what you collect">
        <ListEditor
          values={(draft.settings.fields || []).map((field) => field.label)}
          onChange={(values) =>
            setSetting(
              "fields",
              values.map((label, index) => ({
                id: index === 0 ? "email" : `field-${index + 1}`,
                label,
                type: index === 0 ? "email" : "text",
                required: index === 0,
              })),
            )
          }
          placeholder="Field label"
          addLabel="Add field"
        />
        <Field label="Success message">
          <input
            value={draft.settings.confirmationMessage || ""}
            onChange={(e) => setSetting("confirmationMessage", e.target.value)}
            className={inputClass}
          />
        </Field>
      </FormSection>
    );
  return (
    <FormSection eyebrow="Referral" title="The application tracks the referral">
      <div className="rounded-2xl bg-[#fff3c6] px-4 py-4 text-sm leading-6 text-[#7b5800]">
        The public block points to signup with your creator attribution. Clicks are recorded
        immediately; commission eligibility and payout rules remain controlled by the instance
        operator.
      </div>
    </FormSection>
  );
}

function ListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {values.map((value, index) => (
        <div key={index} className="flex gap-2">
          <input
            value={value}
            onChange={(e) =>
              onChange(
                values.map((item, itemIndex) => (itemIndex === index ? e.target.value : item)),
              )
            }
            className={inputClass}
            placeholder={placeholder}
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#f2f5fb] text-[#17213a]/45"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="inline-flex items-center gap-2 rounded-xl bg-[#f2f5fb] px-3 py-2 text-xs font-semibold text-[#3478f6]"
      >
        <Plus className="size-3.5" /> {addLabel}
      </button>
    </div>
  );
}

function CourseLessonEditor({
  lessons,
  onChange,
}: {
  lessons: CommerceLesson[];
  onChange: (lessons: CommerceLesson[]) => void;
}) {
  const update = (index: number, patch: Partial<CommerceLesson>) =>
    onChange(
      lessons.map((lesson, lessonIndex) =>
        lessonIndex === index ? { ...lesson, ...patch } : lesson,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= lessons.length) return;
    const next = [...lessons];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {lessons.map((lesson, index) => (
        <article
          key={lesson.id}
          className="rounded-[22px] border border-black/[0.06] bg-[#f7f8fc] p-4"
        >
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 sm:flex">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-[#fff3c6] text-xs font-semibold text-[#7b5800]">
              {index + 1}
            </span>
            <input
              required
              value={lesson.title}
              maxLength={180}
              onChange={(event) => update(index, { title: event.target.value })}
              className={inputClass}
              placeholder="Lesson title"
            />
            <div className="col-span-2 flex justify-end gap-1 sm:col-span-1 sm:justify-start">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                className="inline-flex size-9 items-center justify-center rounded-xl bg-white text-[#17213a]/55 disabled:opacity-25"
                aria-label={`Move lesson ${index + 1} up`}
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === lessons.length - 1}
                className="inline-flex size-9 items-center justify-center rounded-xl bg-white text-[#17213a]/55 disabled:opacity-25"
                aria-label={`Move lesson ${index + 1} down`}
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onChange(lessons.filter((_, lessonIndex) => lessonIndex !== index))}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-[#17213a]/40"
                aria-label={`Remove lesson ${index + 1}`}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <input
                value={lesson.moduleTitle || ""}
                onChange={(event) => update(index, { moduleTitle: event.target.value })}
                className={inputClass}
                placeholder="Module name, e.g. Getting started"
              />
              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-2xl bg-white px-4 text-xs font-semibold text-[#17213a]/65">
                <input
                  type="checkbox"
                  checked={Boolean(lesson.isPreview)}
                  onChange={(event) => update(index, { isPreview: event.target.checked })}
                  className="size-4 accent-emerald-600"
                />
                Free preview
              </label>
            </div>
            <input
              value={lesson.summary || ""}
              onChange={(event) => update(index, { summary: event.target.value })}
              className={inputClass}
              placeholder="Short lesson summary"
            />
            <textarea
              value={lesson.body || ""}
              onChange={(event) => update(index, { body: event.target.value, contentType: "text" })}
              className={`${inputClass} min-h-28 resize-y`}
              placeholder="Write the lesson content. You can also add a resource link below."
            />
            <input
              type="url"
              value={lesson.url || ""}
              onChange={(event) => update(index, { url: event.target.value })}
              className={inputClass}
              placeholder="Optional video, file, or resource URL"
            />
          </div>
        </article>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...lessons,
            {
              id: crypto.randomUUID(),
              moduleTitle: "Course",
              title: "",
              summary: "",
              contentType: "text",
              body: "",
            },
          ])
        }
        className="inline-flex items-center gap-2 rounded-xl bg-[#fff3c6] px-3 py-2 text-xs font-semibold text-[#7b5800]"
      >
        <Plus className="size-3.5" /> Add lesson
      </button>
    </div>
  );
}

function ProductAssetUploader({
  files,
  onChange,
}: {
  files: CommerceAsset[];
  onChange: (files: CommerceAsset[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (selected: File[]) => {
    setBusy(true);
    const uploaded: CommerceAsset[] = [];
    try {
      for (const file of selected) {
        const result = await uploadFileResult(file, "product_file");
        uploaded.push({
          id: crypto.randomUUID(),
          key: result.key,
          name: result.name,
          size: result.size,
          mimeType: result.mimeType,
        });
      }
      onChange([...files, ...uploaded]);
      toast.success(
        uploaded.length === 1 ? "Buyer file uploaded" : `${uploaded.length} files uploaded`,
      );
    } catch (error) {
      if (uploaded.length) onChange([...files, ...uploaded]);
      toast.error(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="space-y-2">
        {files.map((file) => (
          <div key={file.id} className="flex items-center gap-3 rounded-2xl bg-[#f2f5fb] px-4 py-3">
            <span className="flex size-9 items-center justify-center rounded-xl bg-white text-[#3478f6]">
              <Download className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{file.name}</div>
              <div className="text-[10px] text-[#17213a]/40">
                {Math.max(1, Math.round(Number(file.size || 0) / 1024))} KB · private
              </div>
            </div>
            <button
              type="button"
              onClick={() => onChange(files.filter((candidate) => candidate.id !== file.id))}
              className="text-[#17213a]/35"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="mt-3 inline-flex items-center gap-2 rounded-2xl border border-dashed border-[#3478f6]/35 bg-[#eef5ff] px-4 py-3 text-sm font-semibold text-[#3478f6]"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Add
        files for buyers
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files || []);
          if (selected.length) void upload(selected);
          e.target.value = "";
        }}
      />
      <p className="mt-2 text-xs text-[#17213a]/42">
        Only customers with a valid purchase link can download these files.
      </p>
    </div>
  );
}
