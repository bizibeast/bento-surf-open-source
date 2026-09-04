import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DecodedImage } from "@/components/DecodedImage";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import GridLayout, { type Layout, type LayoutItem } from "react-grid-layout/legacy";
import { toast } from "sonner";
import { z } from "zod";
import {
  Plus,
  Trash2,
  Pencil,
  Link as LinkIcon,
  Image as ImageIcon,
  Video,
  MapPin,
  Music2,
  Share2,
  Type as TypeIcon,
  Images,
  Laptop,
  Smartphone,
  Palette,
  Sparkles,
  Camera,
  BarChart3,
  Search,
  Move,
  Check,
  type LucideIcon,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getMyProfile, updateProfile } from "@/lib/profile.functions";
import { getMyNewsletter, saveNewsletterPublication } from "@/lib/newsletter.functions";
import { captureProductEvent } from "@/lib/posthog";
import { uploadFile } from "@/lib/upload";
import {
  getMyBlocks,
  getMySetupBlocks,
  createBlock,
  updateBlock,
  deleteBlock,
  updateBlockLayout,
} from "@/lib/blocks.functions";
import { getMyPages, createPage, renamePage, deletePage } from "@/lib/pages.functions";
import { PageTabs, type PageTab } from "@/components/PageTabs";
import { ShareCard } from "@/components/ShareCard";
import { AppearancePanel } from "@/components/AppearancePanel";
import { PatternBackdrop } from "@/components/patterns/PatternBackdrop";
import { SetupChecklist } from "@/components/SetupChecklist";
import {
  ACCENT_PALETTE,
  DEFAULT_SETTINGS,
  type PatternId,
  type PatternSettings,
} from "@/lib/patterns/registry";

import { BlockRenderer, type Block, type BlockContent } from "@/components/blocks/BlockRenderer";
import { SizePresetIcon } from "@/components/blocks/SizePresetIcon";
import type { NewBlockPayload } from "@/components/blocks/AddBlockPicker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field } from "../login";
import type { Database } from "@/integrations/supabase/types";
import { findPlatform, type PlatformCategory } from "@/lib/platforms";
import { geocodeMapLocation } from "@/lib/map.functions";
import { enrichMapContent, storedMapView } from "@/lib/map-content";
import {
  isSocialEmbedProvider,
  normalizeSocialEmbedContent,
  socialEmbedSourceUrl,
} from "@/lib/social-embeds";
import { errorMessage } from "@/lib/errors";
import { normalizePlan, planHasEntitlement, planName } from "@/lib/plans";
import { renamePublicCalendarPage, setPublicCalendarPage } from "@/lib/booking.functions";
import { setPublicSocialInsights } from "@/lib/social-analytics.functions";
import { publicProfilePath, publicProfileUrl } from "@/lib/application-urls";
import { nextEmptyGridRow } from "@/lib/grid-geometry";
import { consumePostOnboardingUpgradePrompt } from "@/lib/post-onboarding-upgrade";
import { AnalyticsSettingsPanel } from "@/components/settings/AnalyticsSettingsPanel";
import { createLinkSocialInsightsWebMcpTools } from "@/lib/link-webmcp";
import { useWebMcpTools } from "@/lib/webmcp";

// Lazy-load heavy interaction-only components so they don't ship in the initial bundle.
const AddBlockPicker = lazy(() =>
  import("@/components/blocks/AddBlockPicker").then((m) => ({ default: m.AddBlockPicker })),
);
const LinkPopover = lazy(() =>
  import("@/components/blocks/LinkPopover").then((m) => ({ default: m.LinkPopover })),
);
const LinkEditPanel = lazy(() =>
  import("@/components/blocks/LinkEditPanel").then((m) => ({ default: m.LinkEditPanel })),
);

type BlockType = Database["public"]["Enums"]["block_type"];
type DashboardBlock = Block & { x: number; y: number; position: number };
type PageRow = Database["public"]["Tables"]["pages"]["Row"];
type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

export const Route = createFileRoute("/_authenticated/link")({
  head: () => ({ meta: [{ title: "Editor | bento.surf" }] }),
  validateSearch: z.object({ analytics: z.boolean().optional().catch(undefined) }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
    context.queryClient.prefetchQuery({
      queryKey: ["my-blocks", null],
      queryFn: () => getMyBlocks({ data: { pageId: null } }),
    });
    context.queryClient.prefetchQuery({ queryKey: ["my-pages"], queryFn: () => getMyPages() });
    context.queryClient.prefetchQuery({
      queryKey: ["setup-block-types"],
      queryFn: () => getMySetupBlocks(),
    });
  },
  component: DashboardPage,
});

const COLS_LAPTOP = 8;
const COLS_PHONE = 4;
const MARGIN = 12;

type ViewMode = "laptop" | "phone";

function sortLayoutItems(items: readonly LayoutItem[]): LayoutItem[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x || a.i.localeCompare(b.i));
}

function desktopLayoutSignature(blocks: DashboardBlock[]) {
  return [...blocks]
    .sort((a, b) => a.position - b.position || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
    .map((b) => `${b.id}:${b.x},${b.y},${b.w},${b.h},${b.position}`)
    .join("|");
}

function layoutItemsSignature(items: readonly LayoutItem[]) {
  return [...items]
    .sort((a, b) => a.i.localeCompare(b.i))
    .map((item) => `${item.i}:${item.x},${item.y},${item.w},${item.h}`)
    .join("|");
}

function mobileLayoutFromDesktop(blocks: DashboardBlock[]): LayoutItem[] {
  const sorted = [...blocks].sort(
    (a, b) => a.position - b.position || a.y - b.y || a.x - b.x || a.id.localeCompare(b.id),
  );
  return packLayout(
    sorted.map((b) => ({ i: b.id, w: Math.max(b.w, 1), h: Math.max(b.h, 1) })),
    COLS_PHONE,
  );
}

function normalizeMobileLayout(items: readonly LayoutItem[]): LayoutItem[] {
  return packLayout(
    sortLayoutItems(items).map((l) => ({ i: l.i, w: Math.max(l.w, 1), h: Math.max(l.h, 1) })),
    COLS_PHONE,
  );
}

function clampGridItem<T extends LayoutItem>(item: T, cols: number): T {
  const w = Math.min(Math.max(item.w, 1), Math.min(COLS_PHONE, cols));
  const h = Math.max(item.h, 1);
  const x = Math.min(Math.max(item.x, 0), Math.max(0, cols - w));
  return { ...item, x, w, h };
}

// Disallow empty rows: shift items up so each row from 0..maxY has at least one tile.
function collapseEmptyRows<T extends LayoutItem>(items: T[]): T[] {
  if (items.length === 0) return items;
  let result = items.map((it) => ({ ...it }));
  while (true) {
    const maxY = result.reduce((m, it) => Math.max(m, it.y + it.h - 1), 0);
    const occupied = new Set<number>();
    for (const it of result) for (let dy = 0; dy < it.h; dy++) occupied.add(it.y + dy);
    let emptyRow = -1;
    for (let r = 0; r < maxY; r++)
      if (!occupied.has(r)) {
        emptyRow = r;
        break;
      }
    if (emptyRow === -1) return result;
    result = result.map((it) => (it.y > emptyRow ? { ...it, y: it.y - 1 } : it));
  }
}

function overlaps(a: LayoutItem, b: LayoutItem): boolean {
  return a.i !== b.i && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function resolveOverlaps(
  items: readonly LayoutItem[],
  cols: number,
  pinnedId?: string,
): LayoutItem[] {
  const clamped = items.map((item) => clampGridItem({ ...item }, cols));
  const ordered = [...clamped].sort((a, b) => {
    if (a.i === pinnedId) return -1;
    if (b.i === pinnedId) return 1;
    return a.y - b.y || a.x - b.x || a.i.localeCompare(b.i);
  });
  const placed: LayoutItem[] = [];
  for (const item of ordered) {
    const next = { ...item };
    let collision = placed.find((other) => overlaps(next, other));
    while (collision) {
      next.y = collision.y + collision.h;
      collision = placed.find((other) => overlaps(next, other));
    }
    placed.push(next);
  }
  return clamped.map((item) => placed.find((next) => next.i === item.i) ?? item);
}

// Greedy first-fit packing: place items left-to-right, top-to-bottom with no gaps.
function packLayout(items: Array<{ i: string; w: number; h: number }>, cols: number): LayoutItem[] {
  const occupied = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  const isFree = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) if (occupied.has(key(x + dx, y + dy))) return false;
    return true;
  };
  const occupy = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) occupied.add(key(x + dx, y + dy));
  };
  const placed: LayoutItem[] = [];
  for (const it of items) {
    const w = Math.min(Math.max(it.w, 1), cols);
    const h = Math.max(it.h, 1);
    let done = false;
    for (let y = 0; !done; y++) {
      for (let x = 0; x <= cols - w; x++) {
        if (isFree(x, y, w, h)) {
          placed.push({ i: it.i, x, y, w, h });
          occupy(x, y, w, h);
          done = true;
          break;
        }
      }
    }
  }
  return placed;
}

// Desktop: clamp inside grid, prevent overlap, and remove empty rows, but PRESERVE x positions
// (empty columns are allowed; only empty rows are disallowed).
function constrainLayoutToNextRow(
  items: readonly LayoutItem[],
  cols: number,
  pinnedId?: string,
): LayoutItem[] {
  let result = items.map((item) => clampGridItem({ ...item }, cols));
  for (let i = 0; i < 8; i++) {
    const before = layoutItemsSignature(result);
    result = collapseEmptyRows(resolveOverlaps(result, cols, pinnedId));
    if (layoutItemsSignature(result) === before) break;
  }
  return resolveOverlaps(result, cols, pinnedId);
}

function mutateLayoutToMatch(target: Layout, source: readonly LayoutItem[]) {
  const byId = new Map(source.map((item) => [item.i, item]));
  for (const item of target) {
    const next = byId.get(item.i);
    if (!next) continue;
    item.x = next.x;
    item.y = next.y;
    item.w = next.w;
    item.h = next.h;
    item.moved = next.moved ?? false;
  }
}

const MEDIA_OPTIONS: Array<{
  icon: LucideIcon;
  label: string;
  type: BlockType;
  content: BlockContent;
  platformKey?: string;
}> = [
  { icon: ImageIcon, label: "Image", type: "image", content: { url: "", alt: "" } },
  {
    icon: Video,
    label: "Video",
    type: "video",
    content: { url: "" },
    platformKey: "custom_video",
  },
  { icon: Music2, label: "Music", type: "audio", content: { url: "" } },
];

function DashboardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(Boolean(search.analytics));
  // The _authenticated route gate guarantees we have a session here.
  const { data: profile } = useQuery({ queryKey: ["my-profile"], queryFn: () => getMyProfile() });
  const { data: newsletter } = useQuery({
    queryKey: ["email-marketing"],
    queryFn: () => getMyNewsletter(),
  });
  const creatorPlan = normalizePlan(profile?.plan_id, Boolean(profile?.is_pro));
  const liveSocialEnabled = planHasEntitlement(creatorPlan, "liveSocialPreviews");
  const { data: pages = [] } = useQuery({ queryKey: ["my-pages"], queryFn: () => getMyPages() });
  const { data: savedBlocks = [] } = useQuery({
    queryKey: ["my-blocks", activePageId],
    queryFn: () => getMyBlocks({ data: { pageId: activePageId } }),
  });
  const blocks = savedBlocks as DashboardBlock[];
  const { data: setupBlocks = [] } = useQuery({
    queryKey: ["setup-block-types"],
    queryFn: () => getMySetupBlocks(),
  });
  const [hasPreviewedOrShared, setHasPreviewedOrShared] = useState(false);
  const [setupChecklistVisible, setSetupChecklistVisible] = useState(true);
  const [setupChecklistOpenSignal, setSetupChecklistOpenSignal] = useState(0);
  const [welcomeUpgradeOpen, setWelcomeUpgradeOpen] = useState(false);

  useEffect(() => {
    if (!profile?.id) return;
    setHasPreviewedOrShared(
      window.localStorage.getItem(`bento:setup-previewed:${profile.id}`) === "1",
    );
  }, [profile?.id]);

  useEffect(() => {
    if (!profile?.id || normalizePlan(profile.plan_id, Boolean(profile.is_pro)) !== "free") return;
    if (!consumePostOnboardingUpgradePrompt(window.localStorage, profile.id)) return;
    captureProductEvent("onboarding_upgrade_prompt_viewed");
    setWelcomeUpgradeOpen(true);
  }, [profile?.id, profile?.is_pro, profile?.plan_id]);

  const markPreviewedOrShared = () => {
    if (!profile?.id) return;
    window.localStorage.setItem(`bento:setup-previewed:${profile.id}`, "1");
    setHasPreviewedOrShared(true);
  };

  // If the active page disappears (e.g. deleted), fall back to Home.
  useEffect(() => {
    if (activePageId && !pages.some((p) => p.id === activePageId)) setActivePageId(null);
  }, [pages, activePageId]);

  // Returning from Dodo checkout. The webhook flips is_pro asynchronously, so
  // poll the profile briefly, then clean the URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("upgraded")) return;
    toast.success("Payment received - activating your paid plan…");
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      qc.invalidateQueries({ queryKey: ["my-profile"] });
      if (tries >= 5) clearInterval(timer);
    }, 3000);
    window.history.replaceState({}, "", window.location.pathname);
    return () => clearInterval(timer);
  }, [qc]);

  const slugifyClient = (name: string) =>
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "page";

  const pagesMut = {
    create: useMutation({
      mutationFn: async (input: { name: string; url?: string | null }) =>
        createPage({ data: input }),
      onMutate: async (input: { name: string; url?: string | null }) => {
        await qc.cancelQueries({ queryKey: ["my-pages"] });
        const prev = qc.getQueryData<PageRow[]>(["my-pages"]) ?? [];
        const tempId = `temp-${Date.now()}`;
        const optimistic = {
          id: tempId,
          name: input.name.trim(),
          slug: slugifyClient(input.name),
          position: prev.length,
          user_id: "",
          url: input.url ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        qc.setQueryData<PageRow[]>(["my-pages"], [...prev, optimistic]);
        if (!input.url) setActivePageId(tempId);
        return { prev, tempId, isLink: !!input.url };
      },
      onSuccess: (row, _input, ctx) => {
        qc.setQueryData<PageRow[]>(["my-pages"], (cur) =>
          (cur ?? []).map((p) => (p.id === ctx?.tempId ? row : p)),
        );
        if (row?.id && !ctx?.isLink) setActivePageId(row.id);
      },
      onError: (e: Error, _input, ctx) => {
        if (ctx?.prev) qc.setQueryData(["my-pages"], ctx.prev);
        if (!ctx?.isLink) setActivePageId(null);
        toast.error(e.message);
      },
    }),
    rename: useMutation({
      mutationFn: async (input: { id: string; name: string }) => renamePage({ data: input }),
      onMutate: async (input) => {
        await qc.cancelQueries({ queryKey: ["my-pages"] });
        const prev = qc.getQueryData<PageRow[]>(["my-pages"]) ?? [];
        qc.setQueryData<PageRow[]>(
          ["my-pages"],
          prev.map((p) =>
            p.id === input.id
              ? { ...p, name: input.name.trim(), slug: slugifyClient(input.name) }
              : p,
          ),
        );
        return { prev };
      },
      onSuccess: (row) => {
        qc.setQueryData<PageRow[]>(["my-pages"], (cur) =>
          (cur ?? []).map((p) => (p.id === row.id ? row : p)),
        );
      },
      onError: (e: Error, _input, ctx) => {
        if (ctx?.prev) qc.setQueryData(["my-pages"], ctx.prev);
        toast.error(e.message);
      },
    }),
    remove: useMutation({
      mutationFn: async (id: string) => deletePage({ data: { id } }),
      onMutate: async (id: string) => {
        await qc.cancelQueries({ queryKey: ["my-pages"] });
        const prev = qc.getQueryData<PageRow[]>(["my-pages"]) ?? [];
        qc.setQueryData<PageRow[]>(
          ["my-pages"],
          prev.filter((p) => p.id !== id),
        );
        setActivePageId(null);
        return { prev };
      },
      onError: (e: Error, _id, ctx) => {
        if (ctx?.prev) qc.setQueryData(["my-pages"], ctx.prev);
        toast.error(e.message);
      },
    }),
  };
  const calendarPageMut = useMutation({
    mutationFn: (enabled: boolean) => setPublicCalendarPage({ data: { enabled } }),
    onSuccess: (result) => {
      qc.setQueryData<Awaited<ReturnType<typeof getMyProfile>> | null>(["my-profile"], (current) =>
        current
          ? {
              ...current,
              calendar_page_enabled: result.enabled,
            }
          : current,
      );
      void qc.invalidateQueries({ queryKey: ["booking-workspace"] });
      if (!result.enabled) setActivePageId(null);
      toast.success(
        result.enabled
          ? `Calendar added · ${publicProfilePath(result.username, "calendar")}`
          : "Calendar page removed",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update calendar page"),
  });
  const calendarPageNameMut = useMutation({
    mutationFn: (name: string) => renamePublicCalendarPage({ data: { name } }),
    onSuccess: (result) => {
      qc.setQueryData<Awaited<ReturnType<typeof getMyProfile>> | null>(["my-profile"], (current) =>
        current ? { ...current, calendar_page_name: result.name } : current,
      );
      toast.success("Calendar page renamed");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not rename calendar page"),
  });
  const insightsPageMut = useMutation({
    mutationFn: (enabled: boolean) => setPublicSocialInsights({ data: { enabled } }),
    onSuccess: (result) => {
      qc.setQueryData<Awaited<ReturnType<typeof getMyProfile>> | null>(["my-profile"], (current) =>
        current ? { ...current, social_insights_enabled: result.enabled } : current,
      );
      toast.success(result.enabled ? "Insights page added" : "Insights page removed");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update Insights page"),
  });
  useWebMcpTools(
    createLinkSocialInsightsWebMcpTools({
      enabled: Boolean(profile?.social_insights_enabled),
      publicPath: profile?.username ? publicProfilePath(profile.username, "insights") : null,
      setEnabled: (enabled) => insightsPageMut.mutateAsync(enabled),
    }),
  );
  const storePageMut = useMutation({
    mutationFn: (enabled: boolean) => updateProfile({ data: { store_page_enabled: enabled } }),
    onSuccess: (_, enabled) => {
      qc.setQueryData<Awaited<ReturnType<typeof getMyProfile>> | null>(["my-profile"], (current) =>
        current ? { ...current, store_page_enabled: enabled } : current,
      );
      if (!enabled) setActivePageId(null);
      toast.success(enabled ? "Store page added" : "Store page removed");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update Store page"),
  });
  const newsletterPageMut = useMutation({
    mutationFn: (enabled: boolean) => {
      const publication = newsletter?.publication;
      if (!publication) throw new Error("Create your newsletter first.");
      return saveNewsletterPublication({
        data: {
          title: publication.title,
          description: publication.description ?? "",
          senderName: publication.sender_name,
          replyToEmail: publication.reply_to_email,
          postalAddress: publication.postal_address,
          accentColor: publication.accent_color ?? null,
          status: enabled ? "published" : "draft",
        },
      });
    },
    onSuccess: async (_, enabled) => {
      await qc.invalidateQueries({ queryKey: ["email-marketing"] });
      if (!enabled) setActivePageId(null);
      toast.success(enabled ? "Newsletter page added" : "Newsletter page removed");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update Newsletter page"),
  });
  const editorPages: PageTab[] = [
    ...pages,
    ...(profile?.calendar_page_enabled
      ? [
          {
            id: "__calendar",
            name: profile.calendar_page_name || "Calendar",
            slug: "calendar",
            href: publicProfileUrl(profile.username, "calendar", import.meta.env.VITE_PUBLIC_URL),
            system: "calendar" as const,
          },
        ]
      : []),
    ...(profile?.social_insights_enabled
      ? [
          {
            id: "__insights",
            name: "Insights",
            slug: "insights",
            href: publicProfileUrl(profile.username, "insights", import.meta.env.VITE_PUBLIC_URL),
            system: "insights" as const,
          },
        ]
      : []),
    ...(profile?.store_page_enabled
      ? [
          {
            id: "__store",
            name: "Store",
            slug: "store",
            href: publicProfileUrl(profile.username, "store", import.meta.env.VITE_PUBLIC_URL),
            system: "store" as const,
          },
        ]
      : []),
    ...(profile?.username && newsletter?.publication?.status === "published"
      ? [
          {
            id: "__newsletter",
            name: "Newsletters",
            slug: "newsletters",
            href: publicProfileUrl(
              profile.username,
              "newsletters",
              import.meta.env.VITE_PUBLIC_URL,
            ),
            system: "newsletter" as const,
          },
        ]
      : []),
  ];

  useEffect(() => {
    if (profile && !profile.onboarded) navigate({ to: "/onboarding", replace: true });
  }, [profile, navigate]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [interactiveMapId, setInteractiveMapId] = useState<string | null>(null);
  const [liveSize, setLiveSize] = useState<{ id: string; w: number; h: number } | null>(null);
  const [gridResetKey, setGridResetKey] = useState(0);
  const isGridInteractingRef = useRef(false);
  const dragStartLayoutRef = useRef<LayoutItem[] | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.offsetWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const [viewMode, setViewMode] = useState<ViewMode>("laptop");
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const [mobileLayout, setMobileLayout] = useState<LayoutItem[] | null>(null);
  const mobileDesktopSigRef = useRef("");
  useEffect(() => {
    const update = () => setIsNarrowViewport(window.innerWidth < 640);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const effectiveViewMode: ViewMode = isNarrowViewport ? "phone" : viewMode;

  useEffect(() => {
    setInteractiveMapId(null);
  }, [activePageId, effectiveViewMode]);

  const desktopSig = useMemo(() => desktopLayoutSignature(blocks), [blocks]);

  useEffect(() => {
    const shouldRebuildFromDesktop = mobileDesktopSigRef.current !== desktopSig;
    setMobileLayout((current) => {
      if (blocks.length === 0) return null;
      const blockIds = new Set(blocks.map((b) => b.id));
      const hasSameBlocks =
        current?.length === blocks.length && current.every((item) => blockIds.has(item.i));
      return !current || !hasSameBlocks || shouldRebuildFromDesktop
        ? mobileLayoutFromDesktop(blocks)
        : current;
    });
    mobileDesktopSigRef.current = desktopSig;
  }, [blocks, desktopSig]);

  // Desktop is the source of truth. Phone keeps its own packed state derived from
  // desktop order, so phone edits never overwrite laptop coordinates.
  const layout = useMemo<LayoutItem[]>(() => {
    const cols = effectiveViewMode === "phone" ? COLS_PHONE : COLS_LAPTOP;
    const sorted = [...blocks].sort((a, b) => a.position - b.position);
    if (effectiveViewMode === "phone") {
      return mobileLayout ?? mobileLayoutFromDesktop(blocks);
    }
    return sorted.map((b) => {
      const w = Math.min(Math.max(b.w, 1), cols);
      const h = Math.max(b.h, 1);
      const x = Math.min(Math.max(b.x ?? 0, 0), Math.max(0, cols - w));
      const y = Math.max(b.y ?? 0, 0);
      return { i: b.id, x, y, w, h };
    });
  }, [blocks, effectiveViewMode, mobileLayout]);

  const layoutMut = useMutation({
    mutationFn: async (
      items: Array<{ id: string; x: number; y: number; w: number; h: number; position: number }>,
    ) => updateBlockLayout({ data: { items } }),
  });

  const lastSavedSigRef = useRef<string>("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sigOf = (
    items: Array<{ id: string; x: number; y: number; w: number; h: number; position: number }>,
  ) =>
    items
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((i) => `${i.id}:${i.x},${i.y},${i.w},${i.h},${i.position}`)
      .join("|");

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const createMut = useMutation({
    mutationFn: async (input: NewBlockPayload) => {
      const cols = effectiveViewMode === "phone" ? COLS_PHONE : COLS_LAPTOP;
      const w = Math.min(Math.max(input.w ?? 2, 1), cols);
      const h = Math.max(input.h ?? 2, 1);
      const x = 0;
      const y = nextEmptyGridRow(blocks);
      let content = input.content;
      if (input.type === "map" && content?.location && !storedMapView(content)) {
        content = await enrichMapContent(content, (location) =>
          geocodeMapLocation({ data: { location } }),
        );
      }
      const sized = { ...input, content, w, h, x, y, pageId: activePageId };
      return createBlock({ data: sized });
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["my-blocks", activePageId] });
      qc.invalidateQueries({ queryKey: ["setup-block-types"] });
      const blockType = (created as { type?: string } | null)?.type ?? "unknown";
      captureProductEvent(blocks.length === 0 ? "first_block_added" : "block_added", {
        block_type: blockType,
        page_type: activePageId ? "page" : "home",
      });
    },
  });

  const delMut = useMutation({
    mutationFn: async (id: string) => deleteBlock({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-blocks", activePageId] });
      qc.invalidateQueries({ queryKey: ["setup-block-types"] });
    },
  });

  const handleLayoutChange = (next: Layout, options?: { force?: boolean; pinnedId?: string }) => {
    if (isGridInteractingRef.current && !options?.force) return;

    if (effectiveViewMode === "phone") {
      const packed = normalizeMobileLayout(next);
      setMobileLayout((current) =>
        current && layoutItemsSignature(current) === layoutItemsSignature(packed)
          ? current
          : packed,
      );
      return;
    }

    const normalized = constrainLayoutToNextRow(next, COLS_LAPTOP, options?.pinnedId);
    const changedByNormalize = normalized.some((c) => {
      const orig = next.find((n) => n.i === c.i);
      return !orig || orig.x !== c.x || orig.y !== c.y || orig.w !== c.w || orig.h !== c.h;
    });
    const ordered = normalized.sort((a, b) => a.y - b.y || a.x - b.x);
    const items = ordered.map((l, i) => ({
      id: l.i,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
      position: i,
    }));
    qc.setQueryData<DashboardBlock[]>(["my-blocks", activePageId], (prev) =>
      (prev ?? []).map((b) => {
        const item = items.find((i) => i.id === b.id);
        return item ? { ...b, ...item } : b;
      }),
    );
    if (changedByNormalize) setGridResetKey((k) => k + 1);

    const sig = sigOf(items);
    if (!lastSavedSigRef.current && !options?.force) {
      lastSavedSigRef.current = sig;
      return;
    }
    if (sig === lastSavedSigRef.current && !options?.force) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      lastSavedSigRef.current = sig;
      layoutMut.mutate(items);
    }, 400);
  };

  const [editing, setEditing] = useState<Block | null>(null);
  const [linkPanel, setLinkPanel] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [linkPanelTick, setLinkPanelTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCategory, setPickerCategory] = useState<PlatformCategory>("custom");
  const [pickerPlatformKey, setPickerPlatformKey] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  // Reposition panel on scroll/resize.
  useEffect(() => {
    if (!linkPanel) return;
    const update = () => {
      const el = document.querySelector(`[data-block-id="${linkPanel.id}"]`);
      if (el) setLinkPanel((p) => (p ? { ...p, rect: el.getBoundingClientRect() } : p));
    };
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [linkPanel]);

  // Auto-save panel edits immediately, while coalescing fast typing into the
  // latest value so older network responses cannot overwrite newer edits.
  const panelSaveInFlightRef = useRef(false);
  const panelPendingSaveRef = useRef<{ id: string; content: BlockContent } | null>(null);
  const updateBlockMut = useMutation({
    mutationFn: async (input: { id: string; content: BlockContent }) =>
      updateBlock({ data: input }),
    onError: (e: Error) => toast.error(e.message),
  });
  const flushPanelSave = async () => {
    if (panelSaveInFlightRef.current || !panelPendingSaveRef.current) return;
    panelSaveInFlightRef.current = true;
    const pending = panelPendingSaveRef.current;
    panelPendingSaveRef.current = null;
    try {
      await updateBlockMut.mutateAsync({ id: pending.id, content: pending.content });
    } catch {
      // onError above shows the save failure; keep the autosave loop alive.
    } finally {
      panelSaveInFlightRef.current = false;
      if (panelPendingSaveRef.current) void flushPanelSave();
    }
  };
  const handlePanelChange = (id: string, next: BlockContent) => {
    qc.setQueryData<DashboardBlock[]>(["my-blocks", activePageId], (prev) =>
      (prev ?? []).map((b) => (b.id === id ? { ...b, content: next } : b)),
    );
    panelPendingSaveRef.current = { id, content: next };
    void flushPanelSave();
  };

  const toggleMapInteractionFor = async (block: DashboardBlock) => {
    if (interactiveMapId === block.id) {
      setInteractiveMapId(null);
      return;
    }
    try {
      let view = storedMapView(block.content);
      if (!view) {
        const location = String(block.content?.location ?? "").trim();
        if (!location) throw new Error("Add a map location first");
        view = await geocodeMapLocation({ data: { location } });
        handlePanelChange(block.id, { ...(block.content ?? {}), ...view });
      }
      setInteractiveMapId(block.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not locate this place");
    }
  };

  // Translate any block type's content into the panel's common shape
  // (url / title / description) so fields auto-fill for every tile.
  const toPanelContent = (type: string, c: BlockContent): BlockContent => {
    c = c ?? {};
    switch (type) {
      case "heading":
      case "section_title":
      case "note":
        return { ...c, title: c.title ?? c.text ?? "" };
      case "quote":
        return {
          ...c,
          title: c.title ?? c.text ?? "",
          description: c.description ?? c.author ?? "",
        };
      case "social_link": {
        const p = c.platform ? findPlatform(c.platform) : null;
        const derived = c.handle && p?.urlBase ? `${p.urlBase}${c.handle}` : "";
        return {
          ...c,
          title: c.title ?? c.handle ?? p?.label ?? "",
          url: c.url || derived,
          description: c.description ?? "",
          color: c.color ?? null,
          material: c.material ?? "fill",
          ctaEnabled: c.ctaEnabled ?? true,
          ctaLabel: c.ctaLabel ?? p?.cta ?? "Follow",
        };
      }
      case "image":
        return { ...c, url: c.url ?? "", description: c.description ?? c.alt ?? "" };
      case "map":
        return { ...c, title: c.title ?? "", location: c.location ?? "" };
      case "video":
        if (isSocialEmbedProvider(c.embedProvider)) {
          const originalUrl =
            socialEmbedSourceUrl(c.embedProvider, String(c.originalUrl || c.url || "")) ?? "";
          return { ...c, originalUrl };
        }
        return c;
      case "contact":
        return { ...c, title: c.title ?? c.label ?? "", url: c.url ?? c.value ?? "" };
      case "email_capture":
      case "booking":
      case "tip_jar":
        return { ...c, description: c.description ?? c.subtitle ?? "" };
      default:
        return c;
    }
  };

  // Map common-shape edits back to each tile type's native content keys
  // so the rendered tile reflects the change.
  const fromPanelContent = (type: string, next: BlockContent): BlockContent => {
    switch (type) {
      case "heading":
      case "section_title":
      case "note":
        return { ...next, text: next.title ?? next.text ?? "" };
      case "quote":
        return {
          ...next,
          text: next.title ?? next.text ?? "",
          author: next.description ?? next.author ?? "",
        };
      case "social_link":
        return { ...next, handle: next.handle ?? next.title ?? "" };
      case "image":
        return { ...next, alt: next.description ?? next.alt ?? "" };
      case "map":
        return { ...next, location: next.location ?? "" };
      case "video":
        if (isSocialEmbedProvider(next.embedProvider)) {
          return normalizeSocialEmbedContent(next.embedProvider, next);
        }
        return next;
      case "contact":
        return {
          ...next,
          label: next.title ?? next.label ?? "",
          value: next.url ?? next.value ?? "",
        };
      case "email_capture":
      case "booking":
      case "tip_jar":
        return { ...next, subtitle: next.description ?? next.subtitle ?? "" };
      default:
        return next;
    }
  };

  const openEditFor = (b: Block) => {
    setInteractiveMapId(null);
    const el = document.querySelector(`[data-block-id="${b.id}"]`);
    const rect = el?.getBoundingClientRect();
    if (rect) {
      setLinkPanel({ id: b.id, rect });
      setLinkPanelTick((t) => t + 1);
      return;
    }
    setEditing(b);
  };

  const openPicker = (category: PlatformCategory = "custom", platformKey: string | null = null) => {
    setPickerCategory(category);
    setPickerPlatformKey(platformKey);
    setPickerOpen(true);
  };

  const applyPresetFor = (id: string, w: number, h: number) => {
    const next = layout.map((l) => (l.i === id ? { ...l, w, h } : l));
    if (effectiveViewMode === "phone") {
      const packed = normalizeMobileLayout(next);
      setMobileLayout((current) =>
        current && layoutItemsSignature(current) === layoutItemsSignature(packed)
          ? current
          : packed,
      );
      return;
    }
    handleLayoutChange(next as Layout, { force: true, pinnedId: id });
    qc.setQueryData<Block[]>(["my-blocks", activePageId], (prev) =>
      (prev ?? []).map((b) => (b.id === id ? { ...b, w, h } : b)),
    );
  };

  const initials = (profile?.display_name || profile?.username || "?")[0]?.toUpperCase();
  const headerMode = (profile?.header_mode as "with_photo" | "no_banner") ?? "with_photo";
  const activePattern = (profile?.pattern as PatternId) ?? "none";
  const patternSettings: PatternSettings = {
    ...DEFAULT_SETTINGS,
    ...((profile?.pattern_settings as Partial<PatternSettings> | null) ?? {}),
  };
  const accentId = profile?.accent_color ?? "indigo";
  const accentHex =
    ACCENT_PALETTE.find((a) => a.id === accentId)?.hex ??
    (accentId.startsWith("#") ? accentId : "#6366f1");
  const themeMode = (profile?.theme as "light" | "dark") ?? "light";

  // Derive themed CSS variables from the chosen accent color. The background
  // becomes a very light tint of the accent, foreground a much darker shade,
  // and UI accent/ring follow the accent itself - so selection highlights
  // (e.g. the active tab in the bottom bar) take on the chosen color.
  const accentVars =
    themeMode === "dark"
      ? {
          "--background": `color-mix(in oklab, ${accentHex} 14%, #0b0b14)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 35%, #ffffff)`,
          "--card": `color-mix(in oklab, ${accentHex} 10%, #11111b)`,
          "--muted": `color-mix(in oklab, ${accentHex} 18%, #1a1a22)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 40%, #ffffff)`,
          "--accent": `color-mix(in oklab, ${accentHex} 28%, #1f1f29)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 60%, #ffffff)`,
          "--primary": accentHex,
          "--primary-foreground": `color-mix(in oklab, ${accentHex} 0%, #ffffff)`,
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 22%, #1f1f29)`,
        }
      : {
          "--background": `color-mix(in oklab, ${accentHex} 8%, #ffffff)`,
          "--foreground": `color-mix(in oklab, ${accentHex} 75%, #000000)`,
          "--card": `color-mix(in oklab, ${accentHex} 4%, #ffffff)`,
          "--muted": `color-mix(in oklab, ${accentHex} 14%, #ffffff)`,
          "--muted-foreground": `color-mix(in oklab, ${accentHex} 55%, #000000)`,
          "--accent": `color-mix(in oklab, ${accentHex} 18%, #ffffff)`,
          "--accent-foreground": `color-mix(in oklab, ${accentHex} 70%, #000000)`,
          "--primary": accentHex,
          "--primary-foreground": `color-mix(in oklab, ${accentHex} 0%, #ffffff)`,
          "--ring": accentHex,
          "--border": `color-mix(in oklab, ${accentHex} 20%, #ffffff)`,
        };
  const creatorFontVars = {
    "--font-display": "var(--font-user-headline, var(--font-ui-display))",
    "--font-sans": "var(--font-user-body, var(--font-ui-sans))",
    fontFamily: "var(--font-sans)",
  } as React.CSSProperties;

  return (
    <div
      data-theme={themeMode}
      style={accentVars as React.CSSProperties}
      className={`relative isolate ${themeMode === "dark" ? "dark" : ""} min-h-screen w-full text-foreground`}
    >
      {/* Full-viewport themed backdrop + pattern layer, fixed so it covers
          the entire page regardless of the inner content's max-width. */}
      <div
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        style={{ background: "var(--background)" }}
      >
        {/* Patterns are intentionally rendered in neutral gray, independent of the accent color. */}
        <PatternBackdrop
          pattern={activePattern}
          settings={patternSettings}
          accentHex="#9ca3af"
          theme={themeMode}
        />
      </div>

      <div
        className={`mx-auto w-full ${effectiveViewMode === "phone" ? "max-w-none px-0 pb-32 pt-8" : "max-w-6xl px-3 pb-32 pt-8 lg:px-6 lg:pb-32 lg:pt-0 lg:min-h-[calc(100vh-4rem)]"}`}
      >
        <div
          className={
            effectiveViewMode === "phone"
              ? "mx-auto w-full max-w-[430px] px-4 transition-all duration-300"
              : "grid grid-cols-1 gap-8 lg:grid-cols-[380px_1fr] lg:gap-11 lg:overflow-visible"
          }
        >
          {headerMode === "with_photo" && (
            <aside
              className={
                effectiveViewMode === "phone"
                  ? "flex w-full flex-col items-center text-center mb-6 text-foreground"
                  : "flex w-full flex-col items-center text-center text-foreground lg:sticky lg:top-0 lg:self-start lg:items-start lg:text-left lg:overflow-visible lg:min-h-[calc(100vh-4rem)] lg:py-8 lg:pl-1 lg:pr-2"
              }
            >
              <ProfileSidebar
                profile={profile}
                initials={initials}
                pageTabs={
                  <>
                    <PageTabs
                      pages={editorPages}
                      activeId={activePageId}
                      mode="editor"
                      phoneEditor={effectiveViewMode === "phone"}
                      menuStyle={accentVars as React.CSSProperties}
                      onSelect={(id) => {
                        setActivePageId(id);
                      }}
                      onCreate={(input) => pagesMut.create.mutate(input)}
                      onCreateCalendar={() => calendarPageMut.mutate(true)}
                      onCreateInsights={() => insightsPageMut.mutate(true)}
                      onCreateStore={() => storePageMut.mutate(true)}
                      onCreateNewsletter={
                        newsletter?.publication ? () => newsletterPageMut.mutate(true) : undefined
                      }
                      onRename={(id, name) =>
                        id === "__calendar"
                          ? calendarPageNameMut.mutate(name)
                          : pagesMut.rename.mutate({ id, name })
                      }
                      onDelete={(id) =>
                        id === "__calendar"
                          ? calendarPageMut.mutate(false)
                          : id === "__insights"
                            ? insightsPageMut.mutate(false)
                            : id === "__store"
                              ? storePageMut.mutate(false)
                              : id === "__newsletter"
                                ? newsletterPageMut.mutate(false)
                                : pagesMut.remove.mutate(id)
                      }
                    />
                  </>
                }
              />
            </aside>
          )}

          <div className="lg:overflow-visible lg:pb-32 lg:pt-8 lg:-mx-6 lg:px-6">
            <div ref={containerRef} className="mx-auto w-full transition-all duration-300">
              {blocks.length === 0 ? (
                <div className="flex h-[420px] flex-col items-center justify-center gap-3 text-center">
                  <div className="font-ui-display text-2xl">Your canvas is empty</div>
                  <p className="max-w-xs text-sm text-muted-foreground">
                    Add a social handle, a photo, or a custom link.
                  </p>
                  <button
                    onClick={() => openPicker("custom")}
                    className="mt-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
                  >
                    Add your first block
                  </button>
                </div>
              ) : (
                (() => {
                  const COLS = effectiveViewMode === "phone" ? COLS_PHONE : COLS_LAPTOP;
                  const baseLayout = layout.map((item) => ({
                    ...clampGridItem(item, COLS),
                    isDraggable: item.i !== interactiveMapId,
                    isResizable: item.i !== interactiveMapId,
                  }));
                  return (
                    <GridLayout
                      key={`grid-${effectiveViewMode}-${gridResetKey}`}
                      className="layout"
                      layout={baseLayout}
                      cols={COLS}
                      rowHeight={Math.max(40, (width - MARGIN * (COLS + 1)) / COLS)}
                      width={width}
                      margin={[MARGIN, MARGIN]}
                      useCSSTransforms={effectiveViewMode !== "phone"}
                      isResizable
                      resizeHandles={["se"]}
                      compactType={null}
                      preventCollision={false}
                      allowOverlap={false}
                      draggableCancel=".no-drag"
                      onLayoutChange={handleLayoutChange}
                      onDragStart={(_l, _o, item) => {
                        isGridInteractingRef.current = true;
                        dragStartLayoutRef.current = baseLayout.map((l) => ({ ...l }));
                        if (item) setActiveId(item.i);
                      }}
                      onDrag={(next, _old, item) => {
                        const start = dragStartLayoutRef.current;
                        if (!start || !item) return;
                        // Recompute preview from the ORIGINAL layout every tick so any
                        // tiles previously pushed aside snap back when the dragged tile
                        // moves away from them. Only the dragged tile is pinned at its
                        // current x/y; collisions are resolved fresh against the original.
                        const proposed = start.map((l) =>
                          l.i === item.i ? { ...l, x: item.x, y: item.y, w: item.w, h: item.h } : l,
                        );
                        const preview = resolveOverlaps(proposed, COLS, item.i);
                        mutateLayoutToMatch(next, preview);
                      }}
                      onDragStop={(next, _oldItem, item) => {
                        isGridInteractingRef.current = false;
                        setActiveId(null);
                        const startLayout = dragStartLayoutRef.current;
                        dragStartLayoutRef.current = null;
                        // If the dragged tile ended at the same spot as where it started,
                        // restore the original layout so any tiles temporarily shifted
                        // during the drag snap back to their original positions.
                        if (item && startLayout) {
                          const startItem = startLayout.find((l) => l.i === item.i);
                          if (startItem && startItem.x === item.x && startItem.y === item.y) {
                            setGridResetKey((k) => k + 1);
                            handleLayoutChange(startLayout as Layout, { force: true });
                            return;
                          }
                        }
                        const source = startLayout ?? next;
                        const droppedLayout = item
                          ? source.map((l) =>
                              l.i === item.i
                                ? { ...l, x: item.x, y: item.y, w: item.w, h: item.h }
                                : l,
                            )
                          : next;
                        handleLayoutChange(
                          constrainLayoutToNextRow(droppedLayout, COLS, item?.i) as Layout,
                          { force: true, pinnedId: item?.i },
                        );
                      }}
                      onResizeStart={(_l, _o, item) => {
                        isGridInteractingRef.current = true;
                        if (item) setActiveId(item.i);
                      }}
                      onResize={(_next, _old, item, placeholder) => {
                        if (!item) return;
                        const [sw, sh] = snapToPreset(item.w, item.h);
                        // Force both the live item and placeholder to snapped dims
                        item.w = sw;
                        item.h = sh;
                        if (placeholder) {
                          placeholder.w = sw;
                          placeholder.h = sh;
                        }
                        setLiveSize({ id: item.i, w: sw, h: sh });
                      }}
                      onResizeStop={(next, _old, item) => {
                        isGridInteractingRef.current = false;
                        setActiveId(null);
                        setLiveSize(null);
                        if (!item) return;
                        const [sw, sh] = snapToPreset(item.w, item.h);
                        const snapped = next.map((l) =>
                          l.i === item.i ? { ...l, w: sw, h: sh } : l,
                        );
                        handleLayoutChange(snapped as Layout, { force: true, pinnedId: item.i });
                      }}
                    >
                      {blocks.map((b) => {
                        const mapInteractive = b.type === "map" && interactiveMapId === b.id;
                        const isActive = activeId === b.id || mapInteractive;
                        const live = liveSize && liveSize.id === b.id ? liveSize : null;
                        const layoutItem = layout.find((item) => item.i === b.id);
                        const dispW = live ? live.w : (layoutItem?.w ?? b.w);
                        const dispH = live ? live.h : (layoutItem?.h ?? b.h);
                        const renderBlock = { ...b, w: dispW, h: dispH } as Block;
                        return (
                          <div
                            key={b.id}
                            data-block-id={b.id}
                            className={`group relative rounded-[28px] transition hover:z-30 hover:ring-2 hover:ring-foreground hover:ring-offset-2 hover:ring-offset-background ${isActive || linkPanel?.id === b.id ? "z-30 ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`}
                          >
                            <div style={creatorFontVars} className="contents">
                              <BlockRenderer
                                block={renderBlock}
                                liveSocialEnabled={liveSocialEnabled}
                                mapInteractive={mapInteractive}
                                onMapViewChange={
                                  b.type === "map"
                                    ? (view) =>
                                        handlePanelChange(b.id, {
                                          ...(b.content ?? {}),
                                          ...view,
                                        })
                                    : undefined
                                }
                              />
                            </div>
                            {/* Overlay swallows clicks so links don't navigate while editing */}
                            {!mapInteractive && (
                              <div
                                className="absolute inset-0 z-[1] cursor-move rounded-[28px]"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setActiveId(b.id);
                                }}
                              />
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                delMut.mutate(b.id);
                              }}
                              aria-label="Delete block"
                              className={`no-drag absolute -left-1 -top-1 z-10 inline-flex size-10 items-center justify-center rounded-xl bg-background shadow-md ring-1 ring-border transition hover:bg-destructive hover:text-destructive-foreground group-hover:opacity-100 sm:-left-2 sm:-top-2 sm:size-8 ${isActive ? "opacity-100" : "opacity-0"}`}
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditFor(b as Block);
                              }}
                              aria-label="Edit block"
                              className={`no-drag absolute -right-1 -top-1 z-10 inline-flex size-10 items-center justify-center rounded-xl bg-background shadow-md ring-1 ring-border transition hover:bg-foreground hover:text-background group-hover:opacity-100 sm:-right-2 sm:-top-2 sm:size-8 ${isActive ? "opacity-100" : "opacity-0"}`}
                            >
                              <Pencil className="size-3.5" />
                            </button>

                            {/* pt-3 acts as a hover bridge so cursor can travel from card to toolbar without losing :hover */}
                            <div
                              className={`no-drag fixed bottom-24 left-1/2 z-50 max-w-[calc(100vw-1rem)] -translate-x-1/2 overflow-x-auto pt-3 transition group-hover:pointer-events-auto group-hover:opacity-100 sm:absolute sm:bottom-auto sm:top-full sm:max-w-none sm:overflow-visible ${isActive ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
                            >
                              <SizePresetToolbar
                                current={{ w: dispW, h: dispH }}
                                onPick={(w, h) => applyPresetFor(b.id, w, h)}
                                isMap={b.type === "map"}
                                mapInteractive={mapInteractive}
                                onEditMap={() => {
                                  setInteractiveMapId(null);
                                  openEditFor(b as Block);
                                }}
                                onToggleMapInteraction={() => void toggleMapInteractionFor(b)}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </GridLayout>
                  );
                })()
              )}
            </div>
          </div>
        </div>

        <ShareBar
          username={profile?.username}
          pageSlug={activePageId ? (pages.find((p) => p.id === activePageId)?.slug ?? null) : null}
          joinedAt={profile?.created_at ?? null}
          plan={planName(creatorPlan)}
          onOpenAnalytics={() => setAnalyticsOpen(true)}
          onOpenPicker={openPicker}
          onQuickAdd={(type, content) => createMut.mutate({ type, content, w: 2, h: 2 })}
          onAddPayload={(payload) => createMut.mutate(payload)}
          viewMode={effectiveViewMode}
          onViewModeChange={setViewMode}
          appearanceOpen={appearanceOpen}
          onAppearanceOpenChange={setAppearanceOpen}
          onShared={markPreviewedOrShared}
          setupChecklistVisible={setupChecklistVisible}
          onOpenSetupChecklist={() => setSetupChecklistOpenSignal((value) => value + 1)}
        />

        <Dialog open={analyticsOpen} onOpenChange={setAnalyticsOpen}>
          <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] max-w-6xl overflow-y-auto bg-[#f7f8fc] p-0">
            <DialogHeader className="sticky top-0 z-10 flex-row items-center gap-3 border-b border-black/[0.06] bg-[#f7f8fc]/95 px-5 py-4 pr-12 backdrop-blur-xl sm:px-6">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#dceaff] text-[#3478f6]">
                <BarChart3 className="size-5" />
              </span>
              <div className="text-left">
                <DialogTitle className="font-ui-display text-2xl">Analytics</DialogTitle>
                <p className="mt-0.5 text-xs text-[#17213a]/50">
                  See how people find and use your Bento.
                </p>
              </div>
            </DialogHeader>
            <div className="p-4 sm:p-6">
              <AnalyticsSettingsPanel plan={creatorPlan} />
            </div>
          </DialogContent>
        </Dialog>

        {profile?.id && (
          <SetupChecklist
            profileId={profile.id}
            profile={profile}
            blocks={setupBlocks}
            hasPreviewedOrShared={hasPreviewedOrShared}
            openSignal={setupChecklistOpenSignal}
            onVisibilityChange={setSetupChecklistVisible}
            onAction={(step) => {
              if (step === "profile") {
                const target = profile.display_name?.trim() ? "bio" : "display-name";
                const element = document.querySelector<HTMLElement>(
                  `[data-onboarding-target="${target}"]`,
                );
                element?.scrollIntoView({ behavior: "smooth", block: "center" });
                element?.click();
                return;
              }
              if (step === "photo") {
                document.querySelector<HTMLElement>('[data-onboarding-target="avatar"]')?.click();
                return;
              }
              if (step === "social") {
                openPicker("social");
                return;
              }
              if (step === "content") {
                openPicker("custom");
                return;
              }
              if (step === "design") {
                setAppearanceOpen(true);
                return;
              }
              markPreviewedOrShared();
              window.open(
                publicProfileUrl(profile.username, null, import.meta.env.VITE_PUBLIC_URL),
                "_blank",
                "noopener,noreferrer",
              );
            }}
          />
        )}

        {pickerOpen && (
          <Suspense fallback={null}>
            <AddBlockPicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              initialCategory={pickerCategory}
              initialPlatformKey={pickerPlatformKey}
              onAdd={(payload) => createMut.mutate(payload)}
            />
          </Suspense>
        )}

        <EditBlockDialog
          block={editing}
          canPersist={true}
          onLocalUpdate={() => {
            /* no-op: route is auth-gated, edits always persist */
          }}
          onClose={() => setEditing(null)}
        />

        <UpgradeDialog
          trigger={null}
          open={welcomeUpgradeOpen}
          showFreeOption
          onOpenChange={(open) => {
            if (!open && welcomeUpgradeOpen) {
              captureProductEvent("onboarding_upgrade_skipped");
            }
            setWelcomeUpgradeOpen(open);
          }}
        />

        {linkPanel &&
          (() => {
            const b = blocks.find((x) => x.id === linkPanel.id);
            if (!b) return null;
            return (
              <Suspense fallback={null}>
                <LinkEditPanel
                  key={linkPanelTick}
                  blockId={b.id}
                  blockType={b.type}
                  anchorRect={linkPanel.rect}
                  content={toPanelContent(b.type, b.content ?? {})}
                  currentIconUrl={
                    b.content?.customIcon || b.cover_url || b.content?.image || b.content?.favicon
                  }
                  isCustomLink={b.type === "generic_link"}
                  tileW={b.w}
                  tileH={b.h}
                  onChange={(next: BlockContent) =>
                    handlePanelChange(b.id, fromPanelContent(b.type, next))
                  }
                  onClose={() => {
                    setLinkPanel(null);
                  }}
                />
              </Suspense>
            );
          })()}
      </div>
    </div>
  );
}

function ShareBar({
  username,
  pageSlug,
  joinedAt,
  plan,
  onOpenAnalytics,
  onOpenPicker,
  onQuickAdd,
  onAddPayload,
  viewMode,
  onViewModeChange,
  appearanceOpen,
  onAppearanceOpenChange,
  onShared,
  setupChecklistVisible,
  onOpenSetupChecklist,
}: {
  username?: string | null;
  pageSlug?: string | null;
  joinedAt?: string | null;
  plan?: string;
  onOpenAnalytics: () => void;
  onOpenPicker: (cat: PlatformCategory, platformKey?: string | null) => void;
  onQuickAdd: (type: BlockType, content: BlockContent) => void;
  onAddPayload: (payload: NewBlockPayload) => void;
  viewMode: ViewMode;
  onViewModeChange: (m: ViewMode) => void;
  appearanceOpen: boolean;
  onAppearanceOpenChange: (open: boolean) => void;
  onShared: () => void;
  setupChecklistVisible: boolean;
  onOpenSetupChecklist: () => void;
}) {
  const dockBtn =
    "inline-flex size-9 items-center justify-center rounded-xl text-foreground transition-[transform,background-color,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-accent active:scale-[0.96] motion-reduce:duration-0";
  // Touch devices have no hover - the share card also toggles on tap.
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-2 transition-[left] sm:px-4 lg:left-[var(--app-sidebar-width)]">
      <div className="pointer-events-auto relative flex max-w-full items-center">
        <div className="relative z-10 flex max-w-full items-center gap-1 overflow-visible rounded-2xl bg-background p-1.5 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.25)] ring-1 ring-border">
          {/* Share my Bento - hover (or tap) reveals the share card with circle actions */}
          <div className="group/share relative">
            <button
              type="button"
              disabled={!username}
              onClick={() => {
                setShareOpen((v) => !v);
              }}
              aria-label="Share my Bento"
              aria-expanded={shareOpen}
              title="Share my Bento"
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-emerald-300 to-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-950 transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Share2 className="size-4" />
              <span className="hidden sm:inline">Share my Bento</span>
            </button>
            {username && (
              <div
                className={`absolute bottom-full left-0 z-50 pb-3 transition-opacity group-hover/share:pointer-events-auto group-hover/share:opacity-100 ${
                  shareOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
                }`}
              >
                <div className="rounded-2xl bg-background p-3 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.35)] ring-1 ring-border">
                  <ShareCard
                    username={username}
                    pageSlug={pageSlug ?? null}
                    joinedAt={joinedAt ?? null}
                    plan={plan ?? "Free"}
                    compact
                    onShared={onShared}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="mx-1 h-6 w-px bg-border" />

          {/* Add (open picker) */}
          <button
            onClick={() => onOpenPicker("custom")}
            aria-label="Add block"
            title="Add block"
            className={dockBtn}
          >
            <Plus className="size-4" />
          </button>

          {/* Quick link popover */}
          <Suspense
            fallback={
              <button aria-label="Add link" title="Add link" className={dockBtn}>
                <LinkIcon className="size-4" />
              </button>
            }
          >
            <LinkPopover onAdd={onAddPayload} buttonClassName={dockBtn} />
          </Suspense>

          {/* Media popover */}
          <Popover>
            <PopoverTrigger asChild>
              <button aria-label="Media" title="Media" className={dockBtn}>
                <Images className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" side="top" className="w-auto p-1.5">
              <div className="flex items-center gap-1">
                {MEDIA_OPTIONS.map((m) => {
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.label}
                      onClick={() =>
                        m.platformKey
                          ? onOpenPicker("custom", m.platformKey)
                          : onQuickAdd(m.type, m.content)
                      }
                      aria-label={m.label}
                      title={m.label}
                      className="inline-flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-xs text-foreground transition hover:bg-accent"
                    >
                      <Icon className="size-4" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          {/* Heading / Text */}
          <button
            onClick={() => onQuickAdd("heading", { text: "" })}
            aria-label="Heading / Text"
            title="Heading / Text"
            className={dockBtn}
          >
            <TypeIcon className="size-4" />
          </button>

          {/* Location */}
          <button
            onClick={() => onQuickAdd("map", { location: "", title: "" })}
            aria-label="Location"
            title="Location"
            className={dockBtn}
          >
            <MapPin className="size-4" />
          </button>

          {/* Appearance */}
          <AppearancePopover
            dockBtn={dockBtn}
            open={appearanceOpen}
            onOpenChange={onAppearanceOpenChange}
          />

          <button
            type="button"
            onClick={onOpenAnalytics}
            aria-label="Analytics"
            title="Analytics"
            className={dockBtn}
          >
            <BarChart3 className="size-4" />
          </button>

          {/* View-mode toggles preview desktop/phone layouts - hidden on phones,
            where the canvas is already phone-width and the dock must fit 375px. */}
          <div className="mx-1 hidden h-6 w-px bg-border sm:block" />

          {/* Laptop view */}
          <button
            onClick={() => onViewModeChange("laptop")}
            aria-label="Laptop view"
            title="Laptop view"
            className="hidden size-9 items-center justify-center rounded-xl transition sm:inline-flex"
            style={
              viewMode === "laptop" ? { background: "var(--ring)", color: "white" } : undefined
            }
          >
            <Laptop className="size-4" />
          </button>

          {/* Phone view */}
          <button
            onClick={() => onViewModeChange("phone")}
            aria-label="Phone view"
            title="Phone view"
            className="hidden size-9 items-center justify-center rounded-xl transition hover:bg-accent sm:inline-flex"
            style={viewMode === "phone" ? { background: "var(--ring)", color: "white" } : undefined}
          >
            <Smartphone className="size-4" />
          </button>

          {setupChecklistVisible && (
            <button
              type="button"
              onClick={onOpenSetupChecklist}
              aria-label="Finish your setup"
              title="Finish your setup"
              className={dockBtn}
            >
              <Sparkles className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Labels are HxW (rows × cols). Grid uses {w: cols, h: rows}.
const SIZE_PRESETS: Array<{ w: number; h: number; label: string }> = [
  { w: 1, h: 1, label: "1×1" }, // tiny square
  { w: 2, h: 2, label: "2×2" }, // small square
  { w: 4, h: 1, label: "1×4" }, // thin wide bar
  { w: 4, h: 2, label: "2×4" }, // horizontal rectangle
  { w: 2, h: 4, label: "4×2" }, // vertical rectangle
  { w: 4, h: 4, label: "4×4" }, // medium square
];

function snapToPreset(w: number, h: number): [number, number] {
  let best = SIZE_PRESETS[0];
  let bestScore = Infinity;
  for (const p of SIZE_PRESETS) {
    const score = Math.abs(p.w - w) + Math.abs(p.h - h);
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return [best.w, best.h];
}

function SizePresetToolbar({
  current,
  onPick,
  isMap = false,
  mapInteractive = false,
  onEditMap,
  onToggleMapInteraction,
}: {
  current: { w: number; h: number };
  onPick: (w: number, h: number) => void;
  isMap?: boolean;
  mapInteractive?: boolean;
  onEditMap?: () => void;
  onToggleMapInteraction?: () => void;
}) {
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const onAction = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  return (
    <div className="no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="flex w-max items-center gap-0.5 rounded-xl bg-foreground p-1 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.35)]">
        {SIZE_PRESETS.map(({ w, h, label }) => {
          const active = current.w === w && current.h === h;
          return (
            <button
              key={label}
              type="button"
              onPointerDown={onPointerDown}
              onClick={(e) => onAction(e, () => onPick(w, h))}
              aria-label={label}
              title={label}
              className={`inline-flex size-10 items-center justify-center rounded-xl transition sm:size-9 ${
                active
                  ? "bg-emerald-400 text-emerald-950"
                  : "text-background/80 hover:bg-white/10 hover:text-background"
              }`}
            >
              <SizePresetIcon w={w} h={h} />
            </button>
          );
        })}
        {isMap && onEditMap && onToggleMapInteraction && (
          <>
            <div className="mx-1 h-6 w-px bg-background/20" />
            <button
              type="button"
              onPointerDown={onPointerDown}
              onClick={(e) => onAction(e, onEditMap)}
              aria-label="Edit map location"
              title="Edit map location"
              className="inline-flex size-10 items-center justify-center rounded-xl text-background/80 transition hover:bg-white/10 hover:text-background sm:size-9"
            >
              <Search className="size-[18px]" />
            </button>
            <button
              type="button"
              onPointerDown={onPointerDown}
              onClick={(e) => onAction(e, onToggleMapInteraction)}
              aria-label={mapInteractive ? "Finish moving map" : "Move and zoom map"}
              title={mapInteractive ? "Done" : "Move and zoom map"}
              className={`inline-flex size-10 items-center justify-center rounded-xl transition sm:size-9 ${
                mapInteractive
                  ? "bg-emerald-400 text-emerald-950"
                  : "text-background/80 hover:bg-white/10 hover:text-background"
              }`}
            >
              {mapInteractive ? (
                <Check className="size-[18px]" />
              ) : (
                <Move className="size-[18px]" />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function EditBlockDialog({
  block,
  canPersist,
  onLocalUpdate,
  onClose,
}: {
  block: Block | null;
  canPersist: boolean;
  onLocalUpdate: (id: string, content: BlockContent) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [content, setContent] = useState<BlockContent>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    setContent(block?.content ?? {});
    dirtyRef.current = false;
    setSavedAt(null);
  }, [block]);

  const mut = useMutation({
    mutationFn: async (next: BlockContent) => {
      if (!canPersist) {
        onLocalUpdate(block!.id, next);
        return { ok: true };
      }
      return updateBlock({ data: { id: block!.id, content: next } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "my-blocks" });
      setSavedAt(Date.now());
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Debounced auto-save while editing
  useEffect(() => {
    if (!block || !dirtyRef.current) return;
    const t = setTimeout(() => mut.mutate(content), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, block]);

  if (!block) return null;

  const set = (k: string, v: BlockContent[string]) => {
    dirtyRef.current = true;
    setContent((c) => ({ ...c, [k]: v }));
  };

  return (
    <Dialog open={!!block} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-ui-display text-2xl">Edit block</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate(content);
          }}
        >
          {renderFields(block.type, content, set)}
        </form>
        <DialogFooter>
          <span className="mr-auto text-xs text-muted-foreground">
            {mut.isPending ? "Saving…" : savedAt ? "Saved" : "Auto-saves as you type"}
          </span>
          <button
            onClick={onClose}
            className="rounded-xl bg-foreground px-4 py-2 text-sm text-background"
          >
            Done
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function renderFields(
  type: BlockType,
  c: BlockContent,
  set: (k: string, v: BlockContent[string]) => void,
) {
  const text = (k: string, label: string, placeholder?: string) => (
    <Field
      key={k}
      label={label}
      value={c[k] ?? ""}
      onChange={(v) => set(k, v)}
      placeholder={placeholder}
    />
  );
  const textarea = (k: string, label: string) => (
    <label key={k} className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <textarea
        value={c[k] ?? ""}
        onChange={(e) => set(k, e.target.value)}
        rows={3}
        className="w-full resize-none rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm outline-none focus:border-foreground"
      />
    </label>
  );

  switch (type) {
    case "heading":
      return [
        textarea("text", "Text"),
        <label key="headingLevel" className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Heading size
          </span>
          <select
            value={c.headingLevel ?? "h2"}
            onChange={(e) => set("headingLevel", e.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm outline-none focus:border-foreground"
          >
            {(["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((level) => (
              <option key={level} value={level}>
                {level.toUpperCase()}
              </option>
            ))}
          </select>
        </label>,
        <label key="textColor" className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Text color</span>
          <div className="flex items-center gap-3 rounded-xl border border-input px-3.5 py-2.5">
            <input
              type="color"
              aria-label="Heading text color"
              value={c.textColor ?? "#0a0a0a"}
              onChange={(e) => set("textColor", e.target.value)}
              className="size-7 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            <button
              type="button"
              onClick={() => set("textColor", null)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Use theme color
            </button>
          </div>
        </label>,
        <label
          key="shadow"
          className="flex items-center justify-between rounded-xl border border-input px-3.5 py-3"
        >
          <span className="text-sm">Show block and shadow</span>
          <input
            type="checkbox"
            checked={c.shadow !== false}
            onChange={(e) => set("shadow", e.target.checked)}
            className="size-4 accent-[#3478f6]"
          />
        </label>,
      ];
    case "note":
      return [textarea("text", "Text")];
    case "quote":
      return [textarea("text", "Quote"), text("author", "Author")];
    case "social_link":
      return [
        text("platform", "Platform key"),
        text("handle", "Handle"),
        text("url", "Override URL (optional)"),
      ];
    case "generic_link":
      if (c.kind === "widget") {
        return [text("title", "Title"), textarea("widgetUrl", "Widget HTTPS URL")];
      }
      return [
        text("title", "Title"),
        text("url", "URL", "https://"),
        text("description", "Description (optional)"),
        text("image", "Image URL (optional)"),
      ];
    case "link_preview":
      return [
        text("title", "Title"),
        text("url", "URL", "https://"),
        text("description", "Description (optional)"),
        text("image", "Image URL (optional)"),
      ];
    case "image":
      return [text("url", "Image URL"), text("title", "Title (optional)"), text("alt", "Alt text")];
    case "image_gallery":
      return [textarea("_urls_text", "Image URLs (one per line)")];
    case "video":
      if (c.liveProvider === "youtube") {
        return [text("handle", "YouTube channel")];
      }
      return [text("url", c.embedProvider === "twitter" ? "Post URL" : "Video URL")];
    case "spotify":
    case "audio":
      return [text("url", "Embed URL")];
    case "map":
      return [text("location", "Location"), text("title", "Label (optional)")];
    case "contact":
      return [text("kind", "Kind (email/phone)"), text("value", "Value"), text("label", "Label")];
    case "file_download":
      return [text("url", "File URL"), text("title", "Title")];
    case "email_capture":
      return [text("title", "Title"), text("subtitle", "Subtitle")];
    case "booking":
      return [text("title", "Title"), text("subtitle", "Subtitle"), text("url", "Booking URL")];
    case "tip_jar":
      return [text("title", "Title"), text("subtitle", "Subtitle")];
    default:
      return [textarea("_raw", "Raw content")];
  }
}

type ProfileLite =
  | {
      username?: string | null;
      display_name?: string | null;
      bio?: string | null;
      avatar_url?: string | null;
      is_pro?: boolean | null;
    }
  | null
  | undefined;

function ProfileSidebar({
  profile,
  initials,
  pageTabs,
}: {
  profile: ProfileLite;
  initials: string;
  pageTabs?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: async (patch: ProfileUpdate) => updateProfile({ data: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-profile"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const upload = async (file: File) => {
    try {
      const publicUrl = await uploadFile(file, "avatar");
      await save.mutateAsync({ avatar_url: publicUrl });
      toast.success("Avatar updated");
    } catch (error: unknown) {
      toast.error(errorMessage(error, "Upload failed"));
    }
  };

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Change avatar"
          data-onboarding-target="avatar"
          className="group relative block"
        >
          {profile?.avatar_url ? (
            <DecodedImage
              src={profile.avatar_url}
              alt=""
              width={640}
              height={640}
              loading="eager"
              fetchPriority="high"
              className="size-32 rounded-full object-cover ring-1 ring-border lg:size-40"
            />
          ) : (
            <div
              className="flex size-32 items-center justify-center rounded-full bg-foreground font-display text-5xl text-background lg:size-40"
              style={{
                fontFamily: "var(--font-user-headline, var(--font-ui-display))",
              }}
            >
              {initials}
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition group-hover:opacity-100">
            <Camera className="size-6" />
          </div>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
      </div>

      <div className="mt-4 flex items-center gap-1.5">
        <EditableText
          as="h2"
          value={profile?.display_name ?? ""}
          placeholder={profile?.username ?? "Your name"}
          onSave={(v) => save.mutate({ display_name: v })}
          className="font-display text-2xl text-foreground outline-none"
          style={{ fontFamily: "var(--font-user-headline, var(--font-display))" }}
          onboardingTarget="display-name"
        />
        <VerifiedBadge className="size-[1.15rem]" active={Boolean(profile?.is_pro)} />
      </div>

      {profile?.username && (
        <a
          href={publicProfileUrl(profile.username, null, import.meta.env.VITE_PUBLIC_URL)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground"
          style={{ fontFamily: "var(--font-user-body, inherit)" }}
        >
          bento.surf/@{profile.username}
        </a>
      )}

      <EditableText
        as="p"
        value={profile?.bio ?? ""}
        placeholder="Add a short bio…"
        multiline
        onSave={(v) => save.mutate({ bio: v })}
        className="mt-3 max-w-[16rem] text-sm leading-relaxed text-muted-foreground outline-none"
        style={{ fontFamily: "var(--font-user-body, inherit)" }}
        onboardingTarget="bio"
      />

      {pageTabs}

      {profile && !profile.is_pro && (
        <div className="mt-4">
          <UpgradeDialog />
        </div>
      )}
    </>
  );
}

function EditableText({
  value,
  placeholder,
  onSave,
  multiline,
  as = "p",
  className,
  style,
  onboardingTarget,
}: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  as?: "h2" | "p";
  className?: string;
  style?: React.CSSProperties;
  onboardingTarget?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onSave(draft.trim());
  };

  if (editing) {
    if (multiline) {
      return (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          rows={3}
          maxLength={280}
          style={style}
          className={`${className} w-full resize-none border-0 bg-transparent p-0 outline-none focus:outline-none focus:ring-0 shadow-none text-center lg:text-left`}
          data-onboarding-target={onboardingTarget}
        />
      );
    }
    return (
      <input
        autoFocus
        value={draft}
        maxLength={60}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        style={style}
        className={`${className} w-full border-0 bg-transparent p-0 outline-none focus:outline-none focus:ring-0 shadow-none text-center lg:text-left`}
        data-onboarding-target={onboardingTarget}
      />
    );
  }

  const Tag: "h2" | "p" = as;
  const isEmpty = !value;
  return (
    <Tag
      onClick={() => setEditing(true)}
      style={style}
      className={`${className} cursor-text ${isEmpty ? "italic text-muted-foreground/70" : ""}`}
      title="Click to edit"
      data-onboarding-target={onboardingTarget}
    >
      {value || placeholder}
    </Tag>
  );
}

function AppearancePopover({
  dockBtn,
  open,
  onOpenChange,
}: {
  dockBtn: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button aria-label="Appearance" title="Appearance" className={dockBtn}>
          <Palette className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="top"
        className="w-auto border-0 bg-transparent p-0 shadow-none"
      >
        <AppearancePanel />
      </PopoverContent>
    </Popover>
  );
}
