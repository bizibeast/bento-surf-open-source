import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ArrowLeft, ArrowUp, ArrowDown, X, Plus, Trash2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  PLATFORMS,
  CATEGORIES,
  findPlatform,
  toEmbedUrl,
  type PlatformDef,
  type PlatformCategory,
} from "@/lib/platforms";
import { getMyProfile } from "@/lib/profile.functions";
import {
  blockEntitlement,
  minimumPlanForEntitlement,
  normalizePlan,
  planHasEntitlement,
  planName,
  type EntitlementKey,
  type PlanId,
} from "@/lib/plans";
import { extractWidgetUrl, googleMapsEmbedUrl } from "@/lib/embeds";
import { fetchLinkMetadata } from "@/lib/link-metadata.functions";
import { safeCssColor } from "@/lib/safe-url";
import { normalizeSocialHandle } from "@/lib/social-preview.functions";
import { isSocialEmbedProvider, socialEmbedHelp, socialEmbedUrl } from "@/lib/social-embeds";
import { FileDropzone } from "./FileDropzone";
import { commerceKind, type CommerceProductKind } from "@/lib/commerce";
import type { BlockContent } from "./BlockRenderer";
import type { Database } from "@/integrations/supabase/types";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { MobileTabSelect } from "@/components/MobileTabSelect";
import { getBookingWorkspace } from "@/lib/booking.functions";
import { calendarSetupReadiness } from "@/lib/booking";
import { getStoreOnboardingStatus } from "@/lib/commerce.functions";

export type NewBlockPayload = {
  type: Database["public"]["Enums"]["block_type"];
  content: BlockContent;
  cover_url?: string | null;
  w: number;
  h: number;
};

const SIZE_DEFAULTS: Record<string, { w: number; h: number }> = {
  social_link: { w: 1, h: 1 },
  generic_link: { w: 2, h: 1 },
  link_preview: { w: 2, h: 2 },
  contact: { w: 2, h: 1 },
  video: { w: 4, h: 3 },
  spotify: { w: 2, h: 2 },
  audio: { w: 2, h: 2 },
  image: { w: 2, h: 2 },
  image_gallery: { w: 2, h: 2 },
  section_title: { w: 4, h: 1 },
  heading: { w: 4, h: 1 },
  experience: { w: 2, h: 2 },
  commerce: { w: 2, h: 2 },
  map: { w: 4, h: 2 },
  quote: { w: 2, h: 2 },
};

type MediaKind = "image" | "video" | "audio";

function platformMediaKind(platform: PlatformDef): MediaKind {
  const kind = platform.defaults?.mediaKind;
  return kind === "video" || kind === "audio" ? kind : "image";
}

function normalizeLinkUrl(raw: string) {
  const value = raw.trim();
  if (!value || /^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

export function AddBlockPicker({
  open,
  onOpenChange,
  initialCategory,
  initialPlatformKey,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialCategory?: PlatformCategory;
  initialPlatformKey?: string | null;
  onAdd: (payload: NewBlockPayload) => void;
}) {
  const [category, setCategory] = useState<PlatformCategory>(initialCategory ?? "custom");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<PlatformDef | null>(() =>
    initialPlatformKey ? (findPlatform(initialPlatformKey) ?? null) : null,
  );
  const [lockedFeature, setLockedFeature] = useState<EntitlementKey | null>(null);

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (ql)
      return PLATFORMS.filter((p) => p.label.toLowerCase().includes(ql) || p.key.includes(ql));
    return PLATFORMS.filter((p) => p.category === category);
  }, [category, q]);

  const { data: profile } = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  const { data: bookingWorkspace } = useQuery({
    queryKey: ["booking-workspace"],
    queryFn: () => getBookingWorkspace(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const { data: storeOnboarding } = useQuery({
    queryKey: ["store-onboarding-status"],
    queryFn: () => getStoreOnboardingStatus(),
    enabled: open,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
  const currentPlan = normalizePlan(
    (profile as { plan_id?: unknown } | null)?.plan_id,
    Boolean((profile as { is_pro?: boolean } | null)?.is_pro),
  );
  const calendarReady = bookingWorkspace
    ? calendarSetupReadiness({
        locked: bookingWorkspace.locked,
        availabilityConfigured: bookingWorkspace.availabilityConfigured,
        hasActiveGoogleCalendar: bookingWorkspace.calendarConnections.some(
          (connection: { status?: string }) => connection.status === "active",
        ),
        sessionCount: bookingWorkspace.products.length,
      }).complete
    : false;
  const storeReady = Boolean(storeOnboarding?.ready);

  const reset = () => {
    setQ("");
    setSelected(null);
    setCategory(initialCategory ?? "custom");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent
        overlayClassName="bg-[#17213a]/30 backdrop-blur-[3px]"
        className="isolate h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[1040px] gap-0 overflow-hidden border border-[#17213a]/10 bg-white p-0 shadow-[var(--shadow-float)] sm:h-[min(84dvh,720px)] sm:w-[calc(100vw-3rem)] [&>button]:right-3 [&>button]:top-3 [&>button]:z-30 [&>button]:bg-white [&>button]:p-2 [&>button]:opacity-80 sm:[&>button]:right-5 sm:[&>button]:top-5"
      >
        <DialogTitle className="sr-only">Add a block</DialogTitle>
        {selected ? (
          <BlockForm
            platform={selected}
            currentPlan={currentPlan}
            storeReady={storeReady}
            onBack={() => setSelected(null)}
            onUpgradeLiveSocial={() => setLockedFeature("liveSocialPreviews")}
            onStartCommerce={(kind) => {
              if (!storeReady) {
                onOpenChange(false);
                reset();
                window.location.assign("/store");
                return;
              }
              onOpenChange(false);
              reset();
              window.location.assign(
                kind === "coaching_call" && !calendarReady ? "/calendar" : `/store?create=${kind}`,
              );
            }}
            onSubmit={(payload) => {
              onAdd(payload);
              onOpenChange(false);
              reset();
            }}
          />
        ) : (
          <div className="relative flex size-full min-h-0 flex-col overflow-hidden sm:flex-row">
            <aside className="relative z-10 flex w-full shrink-0 flex-col overflow-hidden border-b border-[#17213a]/10 bg-[#edf4ff] px-3 pb-2 pt-3 sm:w-56 sm:border-b-0 sm:border-r sm:px-4 sm:py-6">
              <div className="relative px-1 pb-2 pr-12 sm:px-2.5 sm:pb-6 sm:pr-0">
                <div className="font-ui-display text-xl text-[#17213a] sm:text-2xl">
                  Add a block
                </div>
                <p className="mt-1 hidden text-xs leading-relaxed text-[#17213a]/55 sm:block">
                  Choose what to add to your page.
                </p>
              </div>
              <MobileTabSelect
                value={category}
                options={CATEGORIES.map((item) => ({ value: item.key, label: item.label }))}
                onChange={(nextCategory) => {
                  setCategory(nextCategory);
                  setQ("");
                }}
                ariaLabel="Block category"
                className="pb-1"
              />
              <nav
                aria-label="Block categories"
                className="no-scrollbar relative hidden min-h-0 flex-1 gap-1 overflow-x-auto pb-1 sm:flex sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:pb-0 sm:pr-0.5"
              >
                {CATEGORIES.map((c) => (
                  <button
                    key={c.key}
                    aria-pressed={category === c.key && !q}
                    onClick={() => {
                      setCategory(c.key);
                      setQ("");
                    }}
                    className={`shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-left text-xs font-medium leading-tight transition-colors sm:shrink sm:whitespace-normal sm:px-3.5 sm:py-2.5 sm:text-sm ${
                      category === c.key && !q
                        ? "border-[#3478f6] bg-[#3478f6] text-white"
                        : "border-transparent text-[#17213a]/68 hover:border-[#17213a]/10 hover:bg-white hover:text-[#17213a]"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </nav>
            </aside>

            <div className="relative z-10 flex min-w-0 flex-1 flex-col bg-white">
              <div className="flex min-h-[68px] items-center border-b border-[#17213a]/10 bg-white px-3 pr-14 sm:min-h-[86px] sm:px-7 sm:pr-20">
                <div className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-[#17213a]/10 bg-[#f7f9fc] px-4 py-3 focus-within:border-[#3478f6]/45 focus-within:bg-white focus-within:ring-4 focus-within:ring-[#3478f6]/10">
                  <Search className="size-4 shrink-0 text-[#3478f6]" />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search blocks…"
                    className="w-full min-w-0 flex-1 bg-transparent text-sm text-[#17213a] outline-none placeholder:text-[#17213a]/40 sm:text-base"
                  />
                  {q && (
                    <button
                      onClick={() => setQ("")}
                      className="rounded-lg p-1.5 text-[#17213a]/55 transition hover:bg-[#edf1f7]"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-4 sm:px-6 sm:py-7">
                <div className="mb-4 flex items-center justify-between px-1 sm:mb-5">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#17213a]/45">
                      {q
                        ? "Search results"
                        : CATEGORIES.find((item) => item.key === category)?.label}
                    </div>
                    <div className="mt-0.5 text-xs text-[#17213a]/40">
                      {list.length} {list.length === 1 ? "block" : "blocks"}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(82px,1fr))] gap-x-1 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(104px,1fr))] sm:gap-x-3 sm:gap-y-5">
                  {list.map((p) => {
                    const Icon = p.icon;
                    const entitlement = blockEntitlement(p.blockType);
                    const planLocked = Boolean(
                      entitlement && !planHasEntitlement(currentPlan, entitlement),
                    );
                    const calendarLocked =
                      p.key === "coaching_call" && !planLocked && storeReady && !calendarReady;
                    const storePaymentLocked =
                      p.blockType === "commerce" && !planLocked && !storeReady;
                    const locked = planLocked || storePaymentLocked || calendarLocked;
                    return (
                      <button
                        key={p.key}
                        onClick={() => {
                          if (planLocked) {
                            setLockedFeature(entitlement);
                            return;
                          }
                          if (storePaymentLocked) {
                            onOpenChange(false);
                            reset();
                            window.location.assign("/store");
                            return;
                          }
                          if (calendarLocked) {
                            onOpenChange(false);
                            reset();
                            window.location.assign("/calendar");
                            return;
                          }
                          setSelected(p);
                        }}
                        className={`group relative flex min-h-[112px] min-w-0 flex-col items-center rounded-2xl border border-transparent px-2 py-2.5 text-center text-[#17213a] transition-colors hover:border-[#17213a]/10 hover:bg-[#f7f9fc] ${
                          locked ? "opacity-55" : ""
                        }`}
                      >
                        <span
                          className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-black/5 shadow-[var(--shadow-subtle)] sm:size-16"
                          style={{ background: p.color, color: p.fg ?? "#fff" }}
                        >
                          <Icon className="relative size-5 sm:size-6" />
                        </span>
                        <span className="mt-2 line-clamp-2 w-full text-[11px] font-medium leading-tight sm:text-xs">
                          {p.label}
                        </span>
                        {locked && (
                          <span className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full border border-[#17213a]/10 bg-white text-[#17213a]/60">
                            <Lock className="size-2.5" />
                          </span>
                        )}
                        {planLocked && entitlement && (
                          <span className="mt-1 text-[9px] font-semibold uppercase tracking-wide text-[#245fd0]">
                            {planName(minimumPlanForEntitlement(entitlement))}
                          </span>
                        )}
                        {calendarLocked && (
                          <span className="mt-1 text-[9px] font-semibold uppercase tracking-wide text-[#245fd0]">
                            Set up Calendar
                          </span>
                        )}
                        {storePaymentLocked && (
                          <span className="mt-1 text-[9px] font-semibold uppercase tracking-wide text-[#245fd0]">
                            Connect payments
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {list.length === 0 && (
                    <div className="col-span-full rounded-2xl border border-[#17213a]/10 bg-[#f7f9fc] p-10 text-center text-sm text-[#17213a]/50">
                      No blocks found.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
      <UpgradeDialog
        trigger={null}
        feature={lockedFeature ?? undefined}
        open={Boolean(lockedFeature)}
        onOpenChange={(next) => !next && setLockedFeature(null)}
      />
    </Dialog>
  );
}

function BlockForm({
  platform,
  currentPlan,
  storeReady,
  onBack,
  onUpgradeLiveSocial,
  onStartCommerce,
  onSubmit,
}: {
  platform: PlatformDef;
  currentPlan: PlanId;
  storeReady: boolean;
  onBack: () => void;
  onUpgradeLiveSocial: () => void;
  onStartCommerce: (kind: CommerceProductKind) => void;
  onSubmit: (p: NewBlockPayload) => void;
}) {
  const [handle, setHandle] = useState("");
  const [url, setUrl] = useState(platform.defaults?.url ?? "");
  const [title, setTitle] = useState(platform.defaults?.title ?? "");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [cover, setCover] = useState<string>("");
  const [media, setMedia] = useState<string>("");
  const [location, setLocation] = useState("");
  const [widgetCode, setWidgetCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mediaKind] = useState<MediaKind>(() => platformMediaKind(platform));
  // Platform-specific variant toggles
  const [useGallery, setUseGallery] = useState(platform.key === "instagram");
  const [galleryUrls, setGalleryUrls] = useState<string[]>(["", "", "", ""]);
  const [expItems, setExpItems] = useState<
    Array<{
      id: string;
      company: string;
      position: string;
      from: string;
      to: string;
      logo: string;
    }>
  >(() => [{ id: crypto.randomUUID(), company: "", position: "", from: "", to: "", logo: "" }]);

  const Icon = platform.icon;
  const isSocial = platform.blockType === "social_link" && !!platform.urlBase;
  const isContact = platform.blockType === "contact";
  const isLink = platform.blockType === "generic_link" || platform.blockType === "link_preview";
  const isMedia = ["custom_image", "custom_video", "custom_audio"].includes(platform.key);
  const isVideo = platform.blockType === "video" && !isMedia;
  const embedProvider = isSocialEmbedProvider(platform.defaults?.embedProvider)
    ? platform.defaults.embedProvider
    : null;
  const isLatestYoutube = platform.defaults?.liveProvider === "youtube";
  const normalizedSocialEmbed = embedProvider ? socialEmbedUrl(embedProvider, url) : null;
  const isSpotify = platform.blockType === "spotify";
  const isAudio = platform.blockType === "audio" && !isMedia;
  const isHeading = platform.blockType === "heading";
  const isQuote = platform.blockType === "quote";
  const isExperience = platform.blockType === "experience";
  const isCommerce = platform.blockType === "commerce";
  const isMap = platform.blockType === "map";
  const isWidget = platform.key === "custom_widget";
  const supportsGraph = platform.key === "github";
  const supportsGallery =
    platform.key === "instagram" || platform.key === "dribbble" || platform.key === "behance";
  const isInstagram = platform.key === "instagram";
  const supportsLiveSocial = [
    "instagram",
    "twitter",
    "tiktok",
    "linkedin",
    "youtube",
    "github",
    "gitlab",
    "reddit",
    "bluesky",
    "mastodon",
  ].includes(platform.key);
  const liveSocialIncluded = planHasEntitlement(currentPlan, "liveSocialPreviews");

  if (isCommerce) {
    const kind = commerceKind(platform.defaults?.productKind as CommerceProductKind);
    return (
      <div className="flex size-full min-h-0 flex-col bg-gradient-to-br from-white/66 via-white/38 to-[#dceaff]/55 text-[#17213a] backdrop-blur-[38px]">
        <div className="flex min-h-[72px] items-center gap-2.5 border-b border-white/70 bg-white/38 px-3 py-3 pr-14 backdrop-blur-2xl sm:min-h-[86px] sm:gap-3 sm:px-7 sm:py-4 sm:pr-20">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex size-10 items-center justify-center rounded-2xl border border-white/80 bg-white/58 text-[#17213a] shadow-sm transition hover:-translate-x-0.5 hover:bg-white/85"
          >
            <ArrowLeft className="size-4" />
          </button>
          <span
            className="relative flex size-12 items-center justify-center overflow-hidden rounded-[18px] border border-white/80 shadow-[0_12px_24px_-14px_rgba(23,33,58,0.45)]"
            style={{ background: platform.color, color: platform.fg ?? "#fff" }}
          >
            <Icon className="size-5" />
          </span>
          <div>
            <div className="font-ui-display text-xl">{kind.label}</div>
            <div className="text-xs text-[#17213a]/48">A real product, not just a link.</div>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-3 py-5 sm:px-6 sm:py-8">
          <div className="w-full max-w-xl rounded-[26px] border border-white/85 bg-white/58 p-4 shadow-[0_26px_70px_-42px_rgba(23,33,58,0.55)] backdrop-blur-2xl sm:rounded-[30px] sm:p-8">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#3478f6]">
              Bento checkout + delivery
            </div>
            <h3 className="mt-3 font-ui-display text-3xl leading-tight">
              Set up {kind.label.toLowerCase()}
            </h3>
            <p className="mt-3 text-sm leading-6 text-[#17213a]/60">{kind.description}</p>
            <div className="mt-5 rounded-2xl bg-[#dceaff]/70 px-4 py-3 text-sm text-[#245fd0]">
              {storeReady
                ? kind.setupHint
                : "Connect a payment gateway first. Bento checks that payments, payouts, and the webhook are ready before Store products can be created."}
            </div>
            <p className="mt-4 text-xs leading-5 text-[#17213a]/45">
              The product builder creates the hosted product page and adds its matching Bento block
              when you save. Draft products stay hidden from visitors until you publish them.
            </p>
            <button
              type="button"
              onClick={() => onStartCommerce(kind.kind)}
              className="mt-7 w-full rounded-2xl bg-[#3478f6] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_14px_30px_-16px_rgba(52,120,246,0.8)] transition hover:-translate-y-0.5 hover:bg-[#2168e5]"
            >
              {storeReady ? "Open product builder" : "Connect payments to continue"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const canSubmit = isMedia
    ? mediaKind === "image"
      ? cover.length > 0
      : mediaKind === "video"
        ? media.length > 0 || url.trim().length > 0
        : media.length > 0
    : isQuote
      ? text.trim().length > 0
      : isWidget
        ? !!extractWidgetUrl(widgetCode)
        : isSocial
          ? handle.trim().length > 0
          : isLatestYoutube
            ? normalizeSocialHandle("youtube", handle).length > 0
            : isContact
              ? text.trim().length > 0
              : isHeading
                ? text.trim().length > 0
                : isExperience
                  ? expItems.some((i) => i.company.trim().length > 0)
                  : isLink && !isMap
                    ? url.trim().length > 0 || cover.length > 0
                    : isMap
                      ? location.trim().length > 0
                      : isVideo
                        ? embedProvider
                          ? !!normalizedSocialEmbed
                          : url.trim().length > 0 || media.length > 0
                        : isSpotify
                          ? url.trim().length > 0
                          : isAudio
                            ? url.trim().length > 0 || media.length > 0
                            : false;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    let type: NewBlockPayload["type"] = platform.blockType;
    let size = SIZE_DEFAULTS[platform.blockType];
    let content: BlockContent = {};
    let coverUrl: string | null = cover || null;
    try {
      if (isMedia) {
        type = mediaKind;
        size = SIZE_DEFAULTS[mediaKind];
        content =
          mediaKind === "image"
            ? {
                url: cover,
                title: title.trim(),
                alt: description.trim(),
              }
            : mediaKind === "video"
              ? { url: media || toEmbedUrl(url.trim()), title: title.trim() }
              : { url: media };
      } else if (isQuote) {
        content = { text: text.trim(), author: description.trim() };
      } else if (isWidget) {
        content = {
          kind: "widget",
          title: title.trim() || "Widget",
          widgetUrl: extractWidgetUrl(widgetCode),
        };
        size = { w: 4, h: 2 };
      } else if (isSocial) {
        const cleanHandle = normalizeSocialHandle(platform.key, handle);
        if (supportsGallery && useGallery && !isInstagram) {
          type = "image_gallery";
          size = { w: 4, h: 2 };
          content = {
            platform: platform.key,
            handle: cleanHandle,
            livePosts: true,
            urls: galleryUrls.filter(Boolean),
          };
        } else {
          content = {
            platform: platform.key,
            handle: cleanHandle,
          };
          if (supportsGraph) {
            content.showGraph = true;
            size = { w: 4, h: 2 };
          } else if (isInstagram && liveSocialIncluded) {
            size = { w: 4, h: 2 };
          }
        }
      } else if (isLatestYoutube) {
        content = {
          liveProvider: "youtube",
          handle: normalizeSocialHandle("youtube", handle),
        };
        size = { w: 4, h: 2 };
      } else if (isContact) {
        content = {
          kind: platform.defaults?.kind ?? "email",
          value: text.trim(),
          label: title || platform.label,
        };
      } else if (isMap) {
        content = { title: title.trim(), location };
      } else if (isLink) {
        const normalizedUrl = normalizeLinkUrl(url);
        const metadata = await fetchLinkMetadata({ data: { url: normalizedUrl } });
        const platformColor = platform.key === "custom_link" ? null : safeCssColor(platform.color);
        content = {
          title: title.trim() || metadata.title || platform.label,
          url: metadata.url,
          description: description.trim(),
          color: metadata.color || platformColor,
        };
        coverUrl ||= metadata.favicon;
      } else if (isVideo) {
        if (embedProvider && normalizedSocialEmbed) {
          content = {
            embedProvider,
            originalUrl: url.trim(),
            url: normalizedSocialEmbed,
            ...(embedProvider === "twitter" ? { twitterTheme: "light" } : {}),
          };
          size =
            embedProvider === "youtube"
              ? { w: 4, h: 2 }
              : embedProvider === "twitter"
                ? { w: 4, h: 2 }
                : { w: 2, h: 3 };
        } else {
          content = { url: media || toEmbedUrl(url) };
        }
      } else if (isSpotify) {
        content = { url };
      } else if (isAudio) {
        content = { url: media || url };
      } else if (isHeading) {
        content = { text: text.trim() };
      } else if (isExperience) {
        const cleaned = expItems
          .filter((i) => i.company.trim().length > 0)
          .map((i) => ({
            id: i.id,
            company: i.company.trim(),
            position: i.position.trim(),
            from: i.from.trim(),
            to: i.to.trim(),
            logo: i.logo,
          }));
        content = { items: cleaned };
        if (cleaned.length > 2) size = { w: 2, h: 3 };
      }

      onSubmit({ type, content, cover_url: coverUrl, w: size.w, h: size.h });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add this block");
      setSubmitting(false);
    }
  };

  return (
    <form
      className="flex size-full min-h-0 flex-col bg-gradient-to-br from-white/58 via-white/34 to-[#dceaff]/45 text-[#17213a] backdrop-blur-[38px] [&_input.rounded-lg]:!bg-white/65 [&_input.rounded-lg]:!text-[#17213a] [&_input.rounded-lg]:!ring-white/80 [&_input.rounded-xl]:!bg-white/65 [&_input.rounded-xl]:!text-[#17213a] [&_input.rounded-xl]:!ring-white/80 [&_input]:placeholder:!text-[#17213a]/35 [&_textarea.rounded-xl]:!bg-white/65 [&_textarea.rounded-xl]:!text-[#17213a] [&_textarea.rounded-xl]:!ring-white/80 [&_textarea]:placeholder:!text-[#17213a]/35"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !submitting) void submit();
      }}
    >
      <div className="flex min-h-[72px] items-center gap-2.5 border-b border-white/70 bg-white/38 px-3 py-3 pr-14 backdrop-blur-2xl sm:min-h-[86px] sm:gap-3 sm:px-7 sm:py-4 sm:pr-20">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex size-10 items-center justify-center rounded-2xl border border-white/80 bg-white/58 text-[#17213a] shadow-sm backdrop-blur-xl transition hover:-translate-x-0.5 hover:bg-white/85"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span
          className="relative flex size-12 items-center justify-center overflow-hidden rounded-[18px] border border-white/80 shadow-[0_12px_24px_-14px_rgba(23,33,58,0.45),inset_0_1px_1px_rgba(255,255,255,0.55)]"
          style={{ background: platform.color, color: platform.fg ?? "#fff" }}
        >
          <Icon className="size-4" />
        </span>
        <div>
          <div className="font-ui-display text-xl">{platform.label}</div>
          <div className="text-xs text-muted-foreground">Make it feel like you.</div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 overflow-y-auto px-3 py-5 sm:px-8 sm:py-7">
        {isMedia && (
          <>
            {mediaKind === "image" ? (
              <>
                <FileDropzone kind="image" value={cover} onChange={setCover} label="Upload image" />
                <Field label="Title (optional)">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Add a title"
                    className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
                  />
                </Field>
                <Field label="Description (optional)">
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe this image"
                    className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
                  />
                </Field>
              </>
            ) : (
              <>
                <FileDropzone
                  kind={mediaKind}
                  value={media}
                  onChange={setMedia}
                  label={`Upload ${mediaKind}`}
                />
                {mediaKind === "video" && (
                  <>
                    <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#17213a]/35">
                      <span className="h-px flex-1 bg-white/80" />
                      or add a URL
                      <span className="h-px flex-1 bg-white/80" />
                    </div>
                    <Field label="Video URL">
                      <input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://example.com/video.mp4"
                        className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
                      />
                    </Field>
                    <Field label="Text tag (optional)">
                      <input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Add a text tag"
                        className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
                      />
                    </Field>
                  </>
                )}
              </>
            )}
          </>
        )}

        {isQuote && (
          <>
            <Field label="Quote">
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={platform.placeholder}
                rows={4}
                className="w-full resize-none rounded-xl bg-muted px-3.5 py-2.5 text-base outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            <Field label="Author (optional)">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Who said it?"
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
          </>
        )}

        {isSocial && (
          <>
            <Field label="Username">
              <div className="flex items-center gap-2 rounded-xl bg-white/65 px-3 py-2.5 ring-1 ring-white/80 backdrop-blur-xl focus-within:ring-2 focus-within:ring-[#3478f6]/45">
                <span className="text-muted-foreground">@</span>
                <input
                  autoFocus
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder={platform.placeholder ?? "username"}
                  className="flex-1 bg-transparent text-sm outline-none"
                />
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {isInstagram
                  ? "Enter an Instagram username. Followers and recent posts load automatically."
                  : `Opens ${platform.urlBase}${handle.replace(/^@/, "") || platform.placeholder}`}
              </div>
            </Field>

            {supportsLiveSocial && (
              <div className="rounded-xl bg-blue-50/85 px-3.5 py-3 text-xs leading-relaxed text-blue-800 ring-1 ring-blue-100">
                <div className="font-semibold">
                  Live{" "}
                  {isInstagram
                    ? "followers and recent posts"
                    : supportsGraph
                      ? "followers and activity"
                      : "social stats"}{" "}
                  {liveSocialIncluded ? "are on" : "are a premium feature"}
                </div>
                <p className="mt-1 text-blue-700/80">
                  {liveSocialIncluded
                    ? "Bento keeps this tile updated automatically. There is nothing else to connect."
                    : "Upgrade to Creator and Bento will enable this automatically."}
                </p>
                {!liveSocialIncluded && (
                  <button
                    type="button"
                    onClick={onUpgradeLiveSocial}
                    className="mt-2 rounded-full bg-[#3478f6] px-3 py-1.5 font-semibold text-white"
                  >
                    View premium plans
                  </button>
                )}
              </div>
            )}

            {supportsGallery && !isInstagram && (
              <>
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl bg-white/55 px-3.5 py-2.5 ring-1 ring-white/80 backdrop-blur-xl">
                  <span className="text-sm">Show recent posts grid</span>
                  <input
                    type="checkbox"
                    checked={useGallery}
                    onChange={(e) => setUseGallery(e.target.checked)}
                    className="size-4 accent-foreground"
                  />
                </label>
                {useGallery && (
                  <div className="grid grid-cols-2 gap-2">
                    {galleryUrls.map((u, i) => (
                      <FileDropzone
                        key={i}
                        kind="cover"
                        value={u}
                        onChange={(v) => {
                          const next = [...galleryUrls];
                          next[i] = v;
                          setGalleryUrls(next);
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {isContact && (
          <>
            <Field label={platform.defaults?.kind === "phone" ? "Phone number" : "Email address"}>
              <input
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={platform.placeholder}
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            <Field label="Label (optional)">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={platform.label}
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
          </>
        )}

        {isLatestYoutube && (
          <Field label="YouTube channel">
            <div className="flex items-center gap-2 rounded-xl bg-white/65 px-3 py-2.5 ring-1 ring-white/80 backdrop-blur-xl focus-within:ring-2 focus-within:ring-[#3478f6]/45">
              <span className="text-muted-foreground">@</span>
              <input
                autoFocus
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder={platform.placeholder ?? "channel handle"}
                className="flex-1 bg-transparent text-sm outline-none"
              />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Bento automatically keeps this block on the channel&apos;s newest public upload.
            </p>
          </Field>
        )}

        {isMap && (
          <div className="space-y-3">
            <Field label="Location">
              <input
                autoFocus
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={platform.placeholder}
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            {location.trim() && (
              <div className="aspect-[2/1] overflow-hidden rounded-2xl border border-border bg-muted">
                <iframe
                  title={`Map preview of ${location}`}
                  src={googleMapsEmbedUrl(location)}
                  className="size-full border-0"
                  loading="lazy"
                />
              </div>
            )}
          </div>
        )}

        {isWidget && (
          <>
            <Field label="Widget title (optional)">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My widget"
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            <Field label="Widget URL or iframe code">
              <textarea
                autoFocus
                value={widgetCode}
                onChange={(e) => setWidgetCode(e.target.value)}
                placeholder={platform.placeholder}
                rows={6}
                className="w-full resize-none rounded-xl bg-muted px-3.5 py-2.5 font-mono text-xs outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                For safety Bento extracts only the HTTPS iframe source. Scripts and raw HTML are
                never injected into the page.
              </p>
              {widgetCode.trim() && !extractWidgetUrl(widgetCode) && (
                <p className="mt-2 text-xs font-medium text-rose-600">
                  Paste an HTTPS widget URL or iframe with an HTTPS src.
                </p>
              )}
            </Field>
          </>
        )}

        {isLink && !isMap && !isWidget && (
          <>
            <Field label="Title">
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My link"
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            <Field label="URL">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            <Field label="Description (optional)">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            <Field label="Cover image (optional)">
              <FileDropzone kind="cover" value={cover} onChange={setCover} />
            </Field>
          </>
        )}

        {isVideo && !isLatestYoutube && (
          <>
            <Field label={embedProvider === "twitter" ? "Post URL" : "Video URL"}>
              <input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={platform.placeholder}
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
              {embedProvider && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {socialEmbedHelp(embedProvider)}
                </p>
              )}
              {embedProvider && url.trim() && !normalizedSocialEmbed && (
                <p className="mt-2 text-xs font-medium text-rose-600">
                  This is not a supported public {embedProvider === "twitter" ? "post" : "video"}{" "}
                  link.
                </p>
              )}
            </Field>
            {!embedProvider && (
              <>
                <div className="text-center text-xs text-muted-foreground">or upload a file</div>
                <FileDropzone kind="video" value={media} onChange={setMedia} />
              </>
            )}
          </>
        )}

        {isSpotify && (
          <Field label="Spotify embed URL">
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={platform.placeholder}
              className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
            />
            <div className="mt-1 text-[11px] text-muted-foreground">
              In Spotify: Share → Embed track/playlist → copy iframe src.
            </div>
          </Field>
        )}

        {isAudio && (
          <>
            <Field label="Audio URL (optional)">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={platform.placeholder}
                className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
              />
            </Field>
            <div className="text-center text-xs text-muted-foreground">or upload an mp3</div>
            <FileDropzone kind="audio" value={media} onChange={setMedia} />
          </>
        )}

        {isHeading && (
          <Field label="Heading text">
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={platform.placeholder ?? "Your heading"}
              className="w-full rounded-xl bg-muted px-3.5 py-2.5 text-base font-medium outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40"
            />
            <div className="mt-1 text-[11px] text-muted-foreground">
              A text-only tile to group sections of your bento.
            </div>
          </Field>
        )}

        {isExperience && (
          <div className="space-y-3">
            {expItems.map((it, idx) => {
              const patch = (p: Partial<typeof it>) =>
                setExpItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, ...p } : x)));
              const remove = () => setExpItems((prev) => prev.filter((x) => x.id !== it.id));
              const move = (direction: -1 | 1) =>
                setExpItems((prev) => {
                  const currentIndex = prev.findIndex((x) => x.id === it.id);
                  const nextIndex = currentIndex + direction;
                  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev;
                  const next = [...prev];
                  [next[currentIndex], next[nextIndex]] = [next[nextIndex], next[currentIndex]];
                  return next;
                });
              const inputCls =
                "w-full rounded-lg bg-muted px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-2 focus:ring-foreground/40";
              return (
                <div key={it.id} className="rounded-2xl border border-border bg-background/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Role {idx + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => move(-1)}
                        disabled={idx === 0}
                        aria-label={`Move role ${idx + 1} up`}
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(1)}
                        disabled={idx === expItems.length - 1}
                        aria-label={`Move role ${idx + 1} down`}
                        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-25"
                      >
                        <ArrowDown className="size-3.5" />
                      </button>
                      {expItems.length > 1 && (
                        <button
                          type="button"
                          onClick={remove}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="size-3" /> Remove
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                        Company logo
                      </div>
                      <FileDropzone
                        kind="image"
                        value={it.logo}
                        onChange={(logo) => patch({ logo })}
                        className="[&>div]:!h-24 [&>div]:!aspect-auto"
                        rounded="xl"
                      />
                    </div>
                    <input
                      autoFocus={idx === 0}
                      value={it.company}
                      onChange={(e) => patch({ company: e.target.value })}
                      placeholder="Company name"
                      className={inputCls}
                    />
                    <input
                      value={it.position}
                      onChange={(e) => patch({ position: e.target.value })}
                      placeholder="Position (optional)"
                      className={inputCls}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={it.from}
                        onChange={(e) => patch({ from: e.target.value })}
                        placeholder="From (e.g. 2022)"
                        className={inputCls}
                      />
                      <input
                        value={it.to}
                        onChange={(e) => patch({ to: e.target.value })}
                        placeholder="To (e.g. Present)"
                        className={inputCls}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              onClick={() =>
                setExpItems((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    company: "",
                    position: "",
                    from: "",
                    to: "",
                    logo: "",
                  },
                ])
              }
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background/60 px-3 py-2.5 text-xs font-medium text-muted-foreground hover:bg-accent"
            >
              <Plus className="size-3.5" /> Add another company
            </button>
            <div className="text-[11px] text-muted-foreground">
              Use the arrows to choose the display order. You can change it again anytime.
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/70 bg-white/42 px-3 py-3 backdrop-blur-2xl sm:justify-between sm:px-8 sm:py-4">
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          Press Enter to save
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-xl px-4 py-2.5 text-sm hover:bg-[#f0efeb]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="rounded-xl bg-[#3478f6] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_25px_-12px_rgba(52,120,246,0.75)] hover:bg-[#2168e5] disabled:opacity-40"
          >
            {submitting ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
