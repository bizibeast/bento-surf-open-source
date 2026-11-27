import type { NewsletterPublicationSummary } from "@/lib/newsletter-publications";
import { NewsletterProductBuilder } from "@/components/commerce/NewsletterProductBuilder";
import { getMyNewsletterPublications } from "@/lib/newsletter.functions";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  BadgePercent,
  BarChart3,
  Check,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
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
  UsersRound,
  WalletCards,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { AppHeader } from "@/components/AppHeader";
import { MicroAppTabs } from "@/components/MicroAppTabs";
import { MicroAppTabMotion } from "@/components/MicroAppPanel";
import { micro } from "@/lib/micro-app-ui";
import { getMyProfile } from "@/lib/profile.functions";
import { safeMediaUrl } from "@/lib/safe-url";
import { publicProductPath } from "@/lib/application-urls";
import { creatorPaymentProvider, type CreatorPaymentProvider } from "@/lib/payment-providers";
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
import { followCurrentConnectPayments } from "@/lib/connect-payments";
import { TRIAL_DAYS } from "@/lib/plans";
import { settingsIntegrationsPath } from "@/lib/settings-integrations";
import { createStoreWebMcpTools } from "@/lib/store-webmcp";
import { useWebMcpTools } from "@/lib/webmcp";
import {
  COMMERCE_KINDS,
  COMMERCE_PRODUCT_KINDS,
  commerceKind,
  commerceProductRequiresPayment,
  formatCommerceMoney,
  isCommerceGrowthKind,
  isCommerceOfferKind,
  pricingLabel,
  type CommerceAudienceContactRecord,
  type CommerceAudienceCampaignRecord,
  type CommerceAudienceEventRecord,
  type CommerceAudienceListRecord,
  type CommerceDiscountCodeRecord,
  type CommerceLeadRecord,
  type CommerceOrderBumpRecord,
  type CommerceOrderItemRecord,
  type CommerceOrderRecord,
  type CommerceProductKind,
  type CommerceProductRecord,
  type CommerceProductSettings,
  type CommerceWebinarRegistrationRecord,
} from "@/lib/commerce";

import { WorkspaceProductComposer } from "@/components/commerce/WorkspaceProductComposer";
import {
  draftFor,
  Field,
  FormSection,
  inputClass,
  SpecificProductFields,
  type ProductDraft,
} from "@/components/commerce/ProductBuilder";

const tabSchema = z.enum(["products", "growth", "orders", "audience", "analytics", "payouts"]);
const optionalKindSchema = z.enum(COMMERCE_PRODUCT_KINDS).optional().catch(undefined);

export const Route = createFileRoute("/_authenticated/store")({
  head: () => ({ meta: [{ title: "Products | this deployment" }] }),
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
  const [newsletterComposer, setNewsletterComposer] = useState<{ publicationId?: string } | null>(
    null,
  );
  const [kindPickerOpen, setKindPickerOpen] = useState(false);
  const [productToDelete, setProductToDelete] = useState<CommerceProductRecord | null>(null);
  const commerceQuery = useQuery({
    queryKey: ["my-commerce"],
    queryFn: () => getMyCommerce(),
  });
  const data = commerceQuery.data as CommerceDashboardData | undefined;
  const isLoading = commerceQuery.isLoading;
  const { data: profile } = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  const publicationsQuery = useQuery({
    queryKey: ["newsletter-publications"],
    queryFn: () => getMyNewsletterPublications(),
    enabled: tab === "products",
  });
  const products = data?.products ?? [];
  const paidNewsletterPublicationIds = new Set(
    products
      .filter((product) => product.kind === "newsletter")
      .map((product) => product.settings.newsletterPublicationId),
  );
  const standalonePublications = (publicationsQuery.data ?? []).filter(
    (publication: NewsletterPublicationSummary) =>
      !paidNewsletterPublicationIds.has(publication.id),
  );
  const offers = products.filter((product) => isCommerceOfferKind(product.kind));
  const growthActions = products.filter((product) => isCommerceGrowthKind(product.kind));
  const paymentReady = Boolean(data?.storeSetup?.ready);
  const editing = edit ? products.find((product) => product.id === edit) : undefined;
  const editingGrowth = Boolean(
    (create && isCommerceGrowthKind(create)) || (editing && isCommerceGrowthKind(editing.kind)),
  );
  const builderOpen = Boolean(
    (edit && editing?.kind !== "newsletter") || (create && create !== "newsletter"),
  );
  const connectPayments = () => {
    void followCurrentConnectPayments(() => {
      window.location.assign(settingsIntegrationsPath("payments"));
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : "Could not start checkout.");
    });
  };
  const openProductCreator = () => {
    if (data?.locked) {
      toast.error("Creating and publishing products requires the Store plan.");
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
    if (data?.locked && create && isCommerceOfferKind(create)) {
      toast.error("Creating and publishing products requires the Store plan.");
      void navigate({
        to: "/store",
        search: { tab: "products", create: undefined, edit: undefined },
        replace: true,
      });
      return;
    }
  }, [navigate, data?.locked, create]);

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
    onSuccess: () => toast.success("Added to your this application"),
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
          <h1 className="mt-5 font-ui-display text-3xl font-normal">
            Turn your this application into a store
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-[#17213a]/55">
            this application Store is included with the Store plan. Upgrade to sell digital
            products, coaching, courses, memberships, communities, collect leads, and use connected
            payments.
          </p>
          <UpgradeDialog
            feature="storeCards"
            trigger={
              <button className="mt-7 rounded-2xl bg-[#3478f6] px-6 py-3.5 text-sm font-semibold text-white hover:bg-[#2168e5]">
                Start a {TRIAL_DAYS}-day trial
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
        {tab === "products" && <div className="mb-4 flex justify-end"></div>}
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
        {!data?.locked && offers.some(commerceProductRequiresPayment) && !paymentReady && (
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
                Free offers remain available. Connect a payment gateway to publish paid offers and
                add their Store blocks.
              </p>
            </div>
            <button
              type="button"
              onClick={connectPayments}
              className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white"
            >
              {data?.storeSetup?.selectedProvider ? "Finish payment setup" : "Connect payments"}
            </button>
          </div>
        )}
        <section className="relative overflow-hidden rounded-[34px] bg-[#17213a] p-6 text-white shadow-[0_30px_80px_-45px_rgba(23,33,58,0.8)] sm:p-8">
          <div className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-[#3478f6]/35 blur-2xl" />
          <div className="pointer-events-none absolute bottom-[-6rem] left-[40%] size-48 rounded-full bg-[#ffc928]/18 blur-2xl" />
          <div className="relative grid gap-7 lg:grid-cols-[1.2fr_1fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-[#dceaff]">
                <Sparkles className="size-3.5" /> Your creator business, inside this application
              </div>
              <h2 className="mt-4 max-w-xl font-ui-display text-4xl leading-[1.02] sm:text-5xl">
                Turn beautiful blocks into things people can buy.
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-white/55">
                this application hosts the product page, checkout hand-off, secure delivery,
                audience data, and access experience. Your storefront stays minimal.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
              <HeroMetric
                label="Products"
                value={(data?.stats.products ?? 0) + standalonePublications.length}
              />
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
              <strong>Safe test checkout is active.</strong> Orders on staging.example.com use mock
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
            <div className="space-y-5">
              {publicationsQuery.isError && (
                <p role="alert" className="text-sm text-muted-foreground">
                  Newsletter publications could not be loaded. Refresh to try again.
                </p>
              )}
              {standalonePublications.length > 0 && (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {standalonePublications.map((publication: NewsletterPublicationSummary) => (
                    <NewsletterProductCard
                      key={publication.id}
                      title={publication.title}
                      status={publication.status}
                      priceLabel="Free newsletter"
                      publicationId={publication.id}
                      subscriberCount={publication.subscriberCount}
                      onEdit={() => setNewsletterComposer({ publicationId: publication.id })}
                    />
                  ))}
                </div>
              )}
              {offers.length === 0 && standalonePublications.length > 0 ? null : offers.length ===
                  0 && !data?.locked ? (
                <StoreOnboarding
                  paymentSetup={data?.storeSetup}
                  onConnectPayments={connectPayments}
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
                  onEditNewsletter={(publicationId) => setNewsletterComposer({ publicationId })}
                  creatorUsername={profile?.username}
                  webinarRegistrations={data?.webinarRegistrations ?? []}
                  canSell={paymentReady}
                  canPublish={!data?.locked}
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
              )}
            </div>
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
          if (kind === "newsletter") {
            setNewsletterComposer({});
            return;
          }
          void navigate({
            to: "/store",
            search: { tab: "products", create: kind, edit: undefined },
          });
        }}
      />

      {editing?.kind === "newsletter" && !editing.settings.newsletterPublicationId ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) closeBuilder();
          }}
        >
          <DialogContent>
            <DialogTitle>Newsletter unavailable</DialogTitle>
            <p role="alert">
              This product is missing its publication link. Open Newsletter to manage the original
              publication.
            </p>
            <Link to="/email-marketing" search={{ section: "overview" }}>
              Open Newsletter
            </Link>
          </DialogContent>
        </Dialog>
      ) : (
        <NewsletterProductBuilder
          open={
            Boolean(newsletterComposer) || create === "newsletter" || editing?.kind === "newsletter"
          }
          publicationId={
            newsletterComposer?.publicationId ||
            (editing?.kind === "newsletter" ? editing.settings.newsletterPublicationId : undefined)
          }
          onOpenChange={(open) => {
            if (!open) {
              setNewsletterComposer(null);
              if (create === "newsletter" || editing?.kind === "newsletter") closeBuilder();
            }
          }}
          onSaved={async () => {
            await Promise.all([
              refresh(),
              queryClient.invalidateQueries({ queryKey: ["newsletter-publications"] }),
            ]);
          }}
        />
      )}

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
        <WorkspaceProductComposer
          open={builderOpen}
          kind={create ?? editing?.kind ?? "digital_product"}
          productId={edit}
          onOpenChange={(open) => {
            if (!open) closeBuilder();
          }}
          onSaved={async () => {
            await refresh();
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
    title: "Community",
    body: "Create a member space with free or paid access and conversations.",
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
  onConnectPayments,
}: {
  paymentSetup?: CommerceDashboardData["storeSetup"];
  onChooseTemplate: (kind: CommerceProductKind) => void;
  onConnectPayments: () => void;
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
              product card before it reaches your this application.
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

      {!paymentReady && (
        <div className="grid gap-6 px-5 py-7 sm:px-8 sm:py-9 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="flex min-w-0 gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#dceaff] text-[#245fd0]">
              <CircleDollarSign className="size-5" />
            </span>
            <div>
              <div className="text-xs font-semibold text-[#3478f6]">For paid offers</div>
              <h4 className="mt-1 font-ui-display text-2xl">Connect your payment gateway</h4>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[#17213a]/52">
                Free offers can be published now. Paid offers require verified payments, payouts,
                and a webhook. Sales settle directly into your provider account.
              </p>
              {selectedProvider && (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-[#f2f5fb] px-3 py-1.5 text-xs font-medium text-[#17213a]/65">
                  <span className="size-2 rounded-full bg-[#f2b84b]" />
                  {selectedProvider.name} selected. Setup is not finished
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onConnectPayments}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-[#17213a] px-5 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-[#263252]"
          >
            {selectedProvider ? `Finish ${selectedProvider.name} setup` : "Connect payments"}
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
      <div className="px-5 py-7 sm:px-8 sm:py-9">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#e7f7ee] text-[#197a4d]">
            <Check className="size-5" />
          </span>
          <div>
            <div className="text-xs font-semibold text-[#197a4d]">
              {paymentReady
                ? `${selectedProvider?.name || "Payments"} connected`
                : "Start with a free or paid offer"}
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
    </section>
  );
}

function NewsletterProductCard({
  title,
  status,
  priceLabel,
  publicationId,
  subscriberCount,
  onEdit,
}: {
  title: string;
  status: string;
  priceLabel: string;
  publicationId?: string;
  subscriberCount?: number;
  onEdit?: () => void;
}) {
  return (
    <article className="overflow-hidden rounded-[30px] border border-black/[0.07] bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-violet-100 text-violet-700">
          <Newspaper className="size-5" />
        </span>
        <StatusPill status={status} />
      </div>
      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Newsletter
      </p>
      <h3 className="mt-1 font-ui-display text-2xl">{title}</h3>
      <p className="mt-2 text-sm font-semibold">{priceLabel}</p>
      {subscriberCount !== undefined && (
        <p className="mt-1 text-xs text-muted-foreground">{subscriberCount} subscribers</p>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="rounded-xl bg-[#dceaff] px-3 py-2.5 text-xs font-semibold text-[#245fd0]"
          >
            Edit newsletter
          </button>
        )}
        <Link
          to="/email-marketing"
          search={{ section: "overview", publication: publicationId }}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#f2f5fb] px-3 py-2.5 text-xs font-semibold"
        >
          Manage in Newsletter
        </Link>
      </div>
    </article>
  );
}

function ProductsPanel({
  products,
  creatorUsername,
  webinarRegistrations,
  canSell,
  canPublish,
  onCreate,
  onEdit,
  onStatus,
  onAddBlock,
  onDelete,
  onAttendance,
  onEditNewsletter,
}: {
  products: CommerceProductRecord[];
  creatorUsername?: string;
  webinarRegistrations: CommerceWebinarRegistrationRecord[];
  canSell: boolean;
  canPublish: boolean;
  onCreate: () => void;
  onEditNewsletter: (publicationId: string) => void;
  onEdit: (id: string) => void;
  onStatus: (id: string, status: "published" | "archived") => void;
  onAddBlock: (id: string) => void;
  onDelete: (product: CommerceProductRecord) => void;
  onAttendance: (registrationId: string, status: "registered" | "attended" | "no_show") => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = products.filter((product) => product.status === "archived").length;
  const visibleProducts = products.filter((product) =>
    showArchived ? product.status === "archived" : product.status !== "archived",
  );
  if (products.length === 0) {
    return (
      <div className="rounded-[32px] border border-dashed border-[#3478f6]/30 bg-white p-10 text-center shadow-sm">
        <div className="mx-auto flex size-16 items-center justify-center rounded-[24px] bg-[#dceaff] text-[#3478f6]">
          <ShoppingBag className="size-7" />
        </div>
        <h3 className="mt-5 font-ui-display text-3xl">Your first offer belongs here.</h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#17213a]/50">
          Pick a product type. this application creates its setup flow, hosted page, and storefront
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
    <div className="space-y-4">
      {(archivedCount > 0 || showArchived) && (
        <div className="flex gap-2" role="group" aria-label="Product status">
          {[
            { archived: false, label: `Active (${products.length - archivedCount})` },
            { archived: true, label: `Archived (${archivedCount})` },
          ].map(({ archived, label }) => (
            <button
              key={label}
              type="button"
              aria-pressed={showArchived === archived}
              onClick={() => setShowArchived(archived)}
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${showArchived === archived ? "bg-[#17213a] text-white" : "bg-white text-[#17213a]/60"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {visibleProducts.length === 0 && (
        <div className="rounded-[30px] border border-dashed border-black/10 bg-white p-10 text-center">
          <h3 className="font-ui-display text-2xl">
            {showArchived ? "No archived products" : "No active products"}
          </h3>
          <p className="mt-2 text-sm text-[#17213a]/60">
            {showArchived
              ? "Products you archive will appear here."
              : "Your archived products are saved in Archived. Create a new product to get started."}
          </p>
          {!showArchived && (
            <button
              type="button"
              onClick={onCreate}
              className="mt-4 rounded-xl bg-[#3478f6] px-4 py-2 text-sm font-semibold text-white"
            >
              Create a product
            </button>
          )}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleProducts.map((product) => {
          if (product.kind === "newsletter")
            return (
              <NewsletterProductCard
                key={product.id}
                title={product.title}
                status={product.status}
                priceLabel={pricingLabel(
                  product.pricing_type,
                  product.price_amount,
                  product.currency,
                  product.billing_interval,
                )}
                publicationId={product.settings.newsletterPublicationId}
                onEdit={
                  product.settings.newsletterPublicationId
                    ? () => onEditNewsletter(product.settings.newsletterPublicationId!)
                    : undefined
                }
              />
            );
          const paymentAllowed =
            canPublish && (canSell || !commerceProductRequiresPayment(product));
          const canAddBlock = paymentAllowed && product.status === "published";
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
                      {registrations.filter((item) => item.status !== "canceled").length} registered
                      · {registrations.filter((item) => item.status === "attended").length} attended
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
                  <button
                    type="button"
                    onClick={() => onEdit(product.id)}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#f2f5fb] px-3 py-2.5 text-xs font-semibold hover:bg-[#e8eef9]"
                  >
                    <Pencil className="size-3.5" /> Edit
                  </button>
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
                      disabled={!paymentAllowed}
                      title={
                        !paymentAllowed ? "Connect a payment gateway before publishing" : undefined
                      }
                      onClick={() => paymentAllowed && onStatus(product.id, "published")}
                      className="rounded-xl bg-[#3478f6] px-3 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#17213a]/12 disabled:text-[#17213a]/40"
                    >
                      {paymentAllowed
                        ? product.status === "archived"
                          ? "Restore"
                          : "Publish"
                        : "Payments required"}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!canAddBlock}
                    title={
                      product.status !== "published"
                        ? "Publish this product before adding a block in this application"
                        : !paymentAllowed
                          ? "Connect a payment gateway before adding Store blocks"
                          : undefined
                    }
                    onClick={() => canAddBlock && onAddBlock(product.id)}
                    className="rounded-xl border border-black/[0.08] px-3 py-2.5 text-xs font-semibold hover:bg-[#f7f8fc] disabled:cursor-not-allowed disabled:text-[#17213a]/30 disabled:hover:bg-transparent"
                  >
                    {paymentAllowed ? "Add block" : "Block locked"}
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
                  {product.status === "archived" && product.sales_count > 0 ? (
                    <p className="col-span-2 text-xs leading-5 text-[#17213a]/55">
                      Kept for existing orders, receipts, and customer access.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDelete(product)}
                      className="col-span-2 inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-100"
                    >
                      <Trash2 className="size-3.5" />{" "}
                      {product.sales_count > 0 ? "Remove product" : "Delete product"}
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
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
            Collect emails and applications, or add your tracked this application referral link.
            These are simple actions-not items for sale.
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
              Add my this application affiliate link
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
  const willArchive = Number(product?.sales_count) > 0;
  return (
    <Dialog open={Boolean(product)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md overflow-hidden rounded-[30px] border-0 bg-white p-0 shadow-2xl">
        <div className="bg-gradient-to-br from-red-50 via-white to-[#eef5ff] p-6 sm:p-7">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-red-100 text-red-600">
            <Trash2 className="size-5" />
          </div>
          <DialogTitle className="mt-5 font-ui-display text-3xl leading-tight text-[#17213a]">
            {willArchive ? "Archive" : "Delete"} {product?.title || "this item"}?
          </DialogTitle>
          <p className="mt-3 text-sm leading-6 text-[#17213a]/55">
            {willArchive
              ? "This removes the product from your active list and its blocks in this application. Existing orders, receipts, and customer access are preserved in Archived."
              : "This removes its blocks in this application and the attached setup. If it has orders or a payment in progress, it will be archived to preserve receipts and customer access."}
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
              {willArchive ? "Archive product" : "Delete permanently"}
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
        body="Test a published product on staging.example.com to see the complete buyer and fee record here."
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
          this application never holds this money. Sales settle directly into your connected payment
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
          Your this application fee
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
      <DialogContent className="max-h-[86dvh] w-[calc(100vw-1.5rem)] max-w-4xl overflow-hidden rounded-[32px] border-white/80 bg-white/92 p-0 shadow-[0_40px_120px_-44px_rgba(23,33,58,.65)] backdrop-blur-2xl">
        <div className="max-h-[86dvh] min-h-0 overflow-y-auto overscroll-contain p-5 [scrollbar-gutter:stable] sm:p-7">
          <DialogTitle className="font-ui-display text-3xl">What do you want to sell?</DialogTitle>
          <p className="-mt-2 text-sm text-[#17213a]/50">
            Pick an offer type for its dedicated setup, hosted page, checkout, and delivery flow.
            Lead forms and this application affiliate links now live in the Grow tab.
          </p>
          <section className="mt-6">
            <h3 className="font-sans text-sm font-semibold">Sell</h3>
            <p className="mt-0.5 text-xs text-[#17213a]/42">
              Products, services, learning, events, and paid access.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {COMMERCE_KINDS.filter((definition) => definition.family === "sell").map(
                (definition) => {
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
                },
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
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
                        isLeadForm
                          ? "Join my email list"
                          : "Build your this application with my link"
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
                        : "Share a concise reason to create a this application through your referral link."
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
                  this application publishes this action and adds its matching block as soon as you
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
