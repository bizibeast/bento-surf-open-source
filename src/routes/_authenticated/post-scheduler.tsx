import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Film,
  ImagePlus,
  LoaderCircle,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  Send,
  Settings,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import {
  SiFacebook,
  SiInstagram,
  SiReddit,
  SiTiktok,
  SiThreads,
  SiX as SiXLogo,
  SiYoutube,
} from "react-icons/si";
import { FaLinkedinIn } from "react-icons/fa";
import { toast } from "sonner";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { DecodedImage } from "@/components/DecodedImage";
import { PreviewAvatar, ProviderPostPreview } from "@/components/scheduler/ProviderPostPreview";
import { PostingTimesDialog } from "@/components/scheduler/PostingTimesDialog";
import { AppHeader } from "@/components/AppHeader";
import { MicroAppPanel, MicroAppTabMotion } from "@/components/MicroAppPanel";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { micro } from "@/lib/micro-app-ui";
import { uploadFileResult } from "@/lib/upload";
import { prepareSchedulerImageUpload } from "@/lib/image-upload";
import { uploadLimitMb } from "@/lib/plans";
import { browserTimeZone } from "@/lib/timezones";
import {
  cancelSocialPost,
  deleteSocialPost,
  duplicateSocialPost,
  getRedditCommunities,
  getSocialScheduler,
  getTikTokCreatorInfo,
  refreshSocialConnectionAvatar,
  savePostingSchedule,
  rescheduleSocialPost,
  saveSocialPost,
} from "@/lib/social-scheduler.functions";
import {
  SOCIAL_PROVIDER_DEFINITIONS,
  prepareSchedulerMediaFiles,
  schedulerCaptionLabel,
  schedulerCaptionLimit,
  schedulerCaptionPlaceholder,
  schedulerMediaCompatibility,
  schedulerMediaKindForFile,
  schedulerPostEngagement,
  schedulerUsesCaption,
  socialCalendarDateKey,
  socialCalendarDates,
  isSocialCalendarPost,
  scheduleTimeForDate,
  defaultScheduleTime,
  nextPostingSlot,
  isSchedulableCalendarDay,
  validatePostForProviders,
  youtubeDetectedFormat,
  clampTikTokCoverTimestampMs,
  YOUTUBE_THUMBNAIL_MAX_BYTES,
  type InstagramTrialGraduationStrategy,
  type SchedulerConnection,
  type SchedulerMedia,
  type SchedulerPost,
  type PostingSchedule,
  type SocialProviderSettings,
  type SocialProvider,
  type YouTubePostFormat,
  type YouTubeVideoMeta,
} from "@/lib/social-scheduler";
import { isoToZonedDateTimeInput, zonedDateTimeInputToIso } from "@/lib/local-datetime";
import {
  requireWebMcpUserConfirmation,
  useWebMcpTools,
  webMcpResult,
  type WebMcpTool,
} from "@/lib/webmcp";

export const Route = createFileRoute("/_authenticated/post-scheduler")({
  head: () => ({ meta: [{ title: "Social scheduler | bento.surf" }] }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["social-scheduler"],
      queryFn: () => getSocialScheduler(),
    });
  },
  component: SchedulerPage,
});

const RESCHEDULABLE_POST_STATUSES = new Set<SchedulerPost["status"]>([
  "draft",
  "scheduled",
  "failed",
  "partially_failed",
]);
const CALENDAR_POST_DRAG_MIME = "application/x-bento-social-post-id";

type SchedulerWebMcpState = Awaited<ReturnType<typeof getSocialScheduler>>;

function schedulerWebMcpSummary(data: SchedulerWebMcpState | undefined) {
  return {
    locked: Boolean(data?.locked),
    postingSchedule: data?.postingSchedule ?? null,
    connections: (data?.connections ?? []).slice(0, 100).map((connection: SchedulerConnection) => ({
      id: connection.id,
      provider: connection.provider,
      handle: connection.handle,
      displayName: connection.displayName,
      status: connection.status,
      canPublish: connection.canPublish,
      publishBlockReason: connection.publishBlockReason,
    })),
    posts: (data?.posts ?? []).slice(0, 100).map((post: SchedulerPost) => ({
      id: post.id,
      body: post.body,
      title: post.title,
      scheduledAt: post.scheduledAt,
      timezone: post.timezone,
      status: post.status,
      media: post.media.map((item: SchedulerMedia) => ({
        name: item.name,
        mimeType: item.mimeType,
      })),
      targets: post.targets.map((target: SchedulerPost["targets"][number]) => ({
        connectionId: target.connectionId,
        provider: target.provider,
        status: target.status,
        errorMessage: target.errorMessage,
        publishedAt: target.publishedAt,
      })),
    })),
  };
}

export function createSchedulerWebMcpTools({
  data,
  onData,
  onAvatar,
}: {
  data: SchedulerWebMcpState | undefined;
  onData: (next: SchedulerWebMcpState) => void;
  onAvatar: (result: { id: string; avatarUrl: string }) => void;
}): WebMcpTool[] {
  const id = { type: "string", format: "uuid" };
  const schedule = {
    type: "object",
    additionalProperties: false,
    properties: {
      timezone: { type: "string", minLength: 1, maxLength: 100 },
      slots: {
        type: "array",
        maxItems: 70,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            day: { type: "integer", minimum: 0, maximum: 6 },
            time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
          },
          required: ["day", "time"],
        },
      },
      naturalOffset: { type: "boolean" },
    },
    required: ["timezone", "slots", "naturalOffset"],
  };
  return [
    {
      name: "bento_get_scheduler_workspace",
      title: "Get scheduler workspace",
      description:
        "Returns posting times, connected-account readiness, and bounded post lifecycle state without media storage URLs or keys.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () =>
        webMcpResult("Loaded the social scheduler workspace.", {
          scheduler: schedulerWebMcpSummary(data),
        }),
    },
    {
      name: "bento_manage_scheduler",
      title: "Manage scheduler lifecycle",
      description:
        "Saves posting times or reschedules, duplicates, cancels, deletes, or repairs a scheduler item after browser approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: [
              "save_posting_schedule",
              "reschedule_post",
              "duplicate_post",
              "cancel_post",
              "delete_post",
              "refresh_avatar",
            ],
          },
          id,
          scheduledAt: { type: "string", format: "date-time" },
          timezone: { type: "string", minLength: 1, maxLength: 100 },
          schedule,
        },
        required: ["action"],
        oneOf: [
          {
            properties: { action: { const: "save_posting_schedule" } },
            required: ["action", "schedule"],
          },
          {
            properties: { action: { const: "reschedule_post" } },
            required: ["action", "id", "scheduledAt"],
          },
          ...["duplicate_post", "cancel_post", "delete_post", "refresh_avatar"].map((action) => ({
            properties: { action: { const: action } },
            required: ["action", "id"],
          })),
        ],
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input, { signal }) => {
        signal.throwIfAborted();
        const action = String(input.action || "");
        await requireWebMcpUserConfirmation("Manage scheduler lifecycle", input);
        signal.throwIfAborted();
        if (action === "refresh_avatar") {
          const result = await refreshSocialConnectionAvatar({ data: { id: String(input.id) } });
          signal.throwIfAborted();
          onAvatar(result);
          return webMcpResult("Repaired the connected-account avatar.", {
            connectionId: result.id,
            repaired: true,
          });
        }
        let next: SchedulerWebMcpState;
        if (action === "save_posting_schedule") {
          next = await savePostingSchedule({ data: input.schedule as PostingSchedule });
        } else if (action === "reschedule_post") {
          next = await rescheduleSocialPost({
            data: {
              id: String(input.id),
              scheduledAt: String(input.scheduledAt),
              ...(typeof input.timezone === "string" ? { timezone: input.timezone } : {}),
            },
          });
        } else if (action === "duplicate_post") {
          next = await duplicateSocialPost({ data: { id: String(input.id) } });
        } else if (action === "cancel_post") {
          next = await cancelSocialPost({ data: { id: String(input.id) } });
        } else if (action === "delete_post") {
          next = await deleteSocialPost({ data: { id: String(input.id) } });
        } else {
          throw new Error("Choose a supported scheduler action.");
        }
        signal.throwIfAborted();
        onData(next);
        return webMcpResult("Updated the social scheduler.", {
          action,
          postId: typeof input.id === "string" ? input.id : null,
          scheduler: schedulerWebMcpSummary(next),
        });
      },
    },
    {
      name: "bento_get_tiktok_creator_info",
      title: "Get TikTok posting options",
      description:
        "Loads current TikTok privacy and interaction constraints for selected connected accounts.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionIds: { type: "array", minItems: 1, maxItems: 2, items: id },
        },
        required: ["connectionIds"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input, { signal }) => {
        signal.throwIfAborted();
        const result = await getTikTokCreatorInfo({
          data: { connectionIds: input.connectionIds as string[] },
        });
        signal.throwIfAborted();
        return webMcpResult("Loaded TikTok posting options.", { creators: result });
      },
    },
    {
      name: "bento_get_reddit_communities",
      title: "Get Reddit communities",
      description: "Lists communities available to one connected Reddit account.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { connectionId: id },
        required: ["connectionId"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input, { signal }) => {
        signal.throwIfAborted();
        const result = await getRedditCommunities({
          data: { connectionId: String(input.connectionId) },
        });
        signal.throwIfAborted();
        return webMcpResult("Loaded Reddit communities.", { communities: result });
      },
    },
  ];
}

function isSchedulerDocument(mimeType: string) {
  return (
    mimeType === "application/pdf" ||
    mimeType === "application/msword" ||
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("presentationml")
  );
}

function defaultScheduleInput(timeZone: string, now = new Date()) {
  return isoToZonedDateTimeInput(new Date(now.getTime() + 30 * 60_000).toISOString(), timeZone);
}

function minimumScheduleInput(timeZone: string, now = new Date()) {
  return isoToZonedDateTimeInput(new Date(now.getTime() + 60_000).toISOString(), timeZone);
}

const PROVIDER_ICONS: Record<SocialProvider, ComponentType<{ className?: string }>> = {
  instagram: SiInstagram,
  facebook: SiFacebook,
  threads: SiThreads,
  tiktok: SiTiktok,
  linkedin: FaLinkedinIn,
  twitter: SiXLogo,
  youtube: SiYoutube,
  reddit: SiReddit,
};

const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  SELF_ONLY: "Only me",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  PUBLIC_TO_EVERYONE: "Everyone",
};

const POST_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const ENGAGEMENT_NUMBER_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

type SchedulerComposeFingerprintInput = {
  body: string;
  title: string;
  scheduledAt: string;
  selected: string[];
  media: SchedulerMedia[];
  providerSettings: SocialProviderSettings;
};

type PendingThumbnail = {
  previewUrl: string;
  file: File | null;
  uploaded: SchedulerMedia | null;
};

function pendingThumbnailMedia(value: PendingThumbnail | null): SchedulerMedia | null {
  if (!value) return null;
  if (value.uploaded) return value.uploaded;
  return {
    key: `local:${value.file?.name || "thumbnail.jpg"}`,
    url: value.previewUrl,
    name: value.file?.name || "thumbnail.jpg",
    mimeType: value.file?.type || "image/jpeg",
    size: value.file?.size || 0,
  };
}

function revokePendingThumbnail(value: PendingThumbnail | null) {
  if (value?.file && value.previewUrl.startsWith("blob:")) URL.revokeObjectURL(value.previewUrl);
}

export function schedulerComposeFingerprint(input: SchedulerComposeFingerprintInput) {
  return JSON.stringify({
    body: input.body,
    title: input.title,
    scheduledAt: input.scheduledAt,
    selected: [...input.selected].sort(),
    media: input.media.map(({ key, url, name, mimeType, size }) => ({
      key,
      url,
      name,
      mimeType,
      size,
    })),
    providerSettings: input.providerSettings,
  });
}

export function fitPreviewScale(availableHeight: number, renderedHeight: number) {
  if (availableHeight <= 0 || renderedHeight <= 0) return 1;
  return Math.min(1, availableHeight / renderedHeight);
}

export function createAvatarRepairHandler(input: {
  refresh: (id: string) => Promise<{ id: string; avatarUrl: string }>;
  onSuccess: (result: { id: string; avatarUrl: string }) => void;
  now?: () => number;
  retryDelayMs?: number;
}) {
  const inFlight = new Map<string, Promise<void>>();
  const retryAfter = new Map<string, number>();
  const now = input.now ?? Date.now;
  const retryDelayMs = input.retryDelayMs ?? 30_000;

  return (id: string) => {
    const existing = inFlight.get(id);
    if (existing) return existing;
    if ((retryAfter.get(id) ?? 0) > now()) return Promise.resolve();

    const request = input
      .refresh(id)
      .then((result) => {
        retryAfter.delete(id);
        input.onSuccess(result);
      })
      .catch(() => {
        retryAfter.set(id, now() + retryDelayMs);
      })
      .finally(() => {
        inFlight.delete(id);
      });
    inFlight.set(id, request);
    return request;
  };
}

function SchedulerPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["social-scheduler"],
    queryFn: () => getSocialScheduler(),
    refetchInterval: (query) => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
      if (query.state.error) return false;
      return query.state.data?.posts.some((post: SchedulerPost) => post.status === "publishing")
        ? 3_000
        : 60_000;
    },
  });
  const repairAvatar = useMemo(
    () =>
      createAvatarRepairHandler({
        refresh: (id) => refreshSocialConnectionAvatar({ data: { id } }),
        onSuccess: ({ id, avatarUrl }) =>
          queryClient.setQueryData(["social-scheduler"], (current: typeof data) =>
            current
              ? {
                  ...current,
                  connections: current.connections.map((connection: SchedulerConnection) =>
                    connection.id === id ? { ...connection, avatarUrl } : connection,
                  ),
                }
              : current,
          ),
      }),
    [queryClient],
  );
  const schedulerWebMcpTools = useMemo(
    () =>
      createSchedulerWebMcpTools({
        data,
        onData: (next) => queryClient.setQueryData(["social-scheduler"], next),
        onAvatar: ({ id, avatarUrl }) =>
          queryClient.setQueryData(["social-scheduler"], (current: typeof data) =>
            current
              ? {
                  ...current,
                  connections: current.connections.map((connection: SchedulerConnection) =>
                    connection.id === id ? { ...connection, avatarUrl } : connection,
                  ),
                }
              : current,
          ),
      }),
    [data, queryClient],
  );
  useWebMcpTools(schedulerWebMcpTools);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState(defaultScheduleTime);
  const [selected, setSelected] = useState<string[]>([]);
  const [media, setMedia] = useState<SchedulerMedia[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [tiktokPrivacy, setTiktokPrivacy] = useState("");
  const [tiktokAllowComment, setTiktokAllowComment] = useState(false);
  const [tiktokAllowDuet, setTiktokAllowDuet] = useState(false);
  const [tiktokAllowStitch, setTiktokAllowStitch] = useState(false);
  const [tiktokCommercial, setTiktokCommercial] = useState(false);
  const [tiktokOwnBrand, setTiktokOwnBrand] = useState(false);
  const [tiktokBrandedContent, setTiktokBrandedContent] = useState(false);
  const [tiktokAiGenerated, setTiktokAiGenerated] = useState(false);
  const [youtubePrivacy, setYoutubePrivacy] = useState("private");
  const [youtubeDescription, setYoutubeDescription] = useState("");
  const [youtubeThumbnail, setYoutubeThumbnail] = useState<PendingThumbnail | null>(null);
  const [youtubeFrameMs, setYoutubeFrameMs] = useState(1_000);
  const [videoMeta, setVideoMeta] = useState<YouTubeVideoMeta | null>(null);
  const [instagramCover, setInstagramCover] = useState<PendingThumbnail | null>(null);
  const [instagramFrameMs, setInstagramFrameMs] = useState(1_000);
  const [instagramTrialReel, setInstagramTrialReel] = useState(false);
  const [instagramGraduationStrategy, setInstagramGraduationStrategy] =
    useState<InstagramTrialGraduationStrategy>("MANUAL");
  const [tiktokCoverMs, setTiktokCoverMs] = useState(1_000);
  const [redditCommunity, setRedditCommunity] = useState("");
  const [redditKind, setRedditKind] = useState<"self" | "link">("self");
  const [xPostKind, setXPostKind] = useState<"post" | "article">("post");
  const [redditUrl, setRedditUrl] = useState("");
  const [previewConnectionId, setPreviewConnectionId] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [savedProviderSettings, setSavedProviderSettings] = useState<SocialProviderSettings>({});
  const [postingSettingsOpen, setPostingSettingsOpen] = useState(false);
  const [publishingPostId, setPublishingPostId] = useState<string | null>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const youtubeThumbInputRef = useRef<HTMLInputElement>(null);
  const instagramCoverInputRef = useRef<HTMLInputElement>(null);
  const initialComposeFingerprintRef = useRef<string | null>(null);
  const youtubeThumbnailRef = useRef<PendingThumbnail | null>(null);
  const instagramCoverRef = useRef<PendingThumbnail | null>(null);
  const schedulerTimeZone = data?.postingSchedule.timezone || browserTimeZone();

  const replacePendingThumbnail = (
    target: "youtube" | "instagram",
    next: PendingThumbnail | null,
  ) => {
    const setter = target === "youtube" ? setYoutubeThumbnail : setInstagramCover;
    setter((current) => {
      if (current?.previewUrl !== next?.previewUrl) revokePendingThumbnail(current);
      return next;
    });
  };

  useEffect(() => {
    youtubeThumbnailRef.current = youtubeThumbnail;
  }, [youtubeThumbnail]);
  useEffect(() => {
    instagramCoverRef.current = instagramCover;
  }, [instagramCover]);
  useEffect(
    () => () => {
      revokePendingThumbnail(youtubeThumbnailRef.current);
      revokePendingThumbnail(instagramCoverRef.current);
    },
    [],
  );

  const resetComposeForm = () => {
    initialComposeFingerprintRef.current = null;
    setBody("");
    setTitle("");
    setMedia([]);
    setSelected([]);
    setScheduledAt(defaultScheduleInput(schedulerTimeZone));
    setTiktokPrivacy("");
    setTiktokAllowComment(false);
    setTiktokAllowDuet(false);
    setTiktokAllowStitch(false);
    setTiktokCommercial(false);
    setTiktokOwnBrand(false);
    setTiktokBrandedContent(false);
    setTiktokAiGenerated(false);
    setYoutubePrivacy("private");
    setYoutubeDescription("");
    replacePendingThumbnail("youtube", null);
    setYoutubeFrameMs(1_000);
    setVideoMeta(null);
    replacePendingThumbnail("instagram", null);
    setInstagramFrameMs(1_000);
    setInstagramTrialReel(false);
    setInstagramGraduationStrategy("MANUAL");
    setTiktokCoverMs(1_000);
    setRedditCommunity("");
    setRedditKind("self");
    setXPostKind("post");
    setRedditUrl("");
    setUploadError(null);
    setPreviewConnectionId("");
    setEditingPostId(null);
    setSavedProviderSettings({});
  };

  const closeCompose = () => {
    setDiscardPromptOpen(false);
    setUploadError(null);
    resetComposeForm();
    setComposeOpen(false);
  };

  const openNewPost = () => {
    resetComposeForm();
    setComposeOpen(true);
  };

  const openComposeForDate = (date: Date, slotTime?: string) => {
    if (data?.locked) return;
    if (!isSchedulableCalendarDay(date)) return;
    if (slotTime) {
      const slotIso = zonedDateTimeInputToIso(
        `${socialCalendarDateKey(date)}T${slotTime}`,
        schedulerTimeZone,
      );
      if (!slotIso || new Date(slotIso).getTime() < Date.now() + 60_000) {
        toast.error("That posting slot has already passed.");
        return;
      }
    }
    resetComposeForm();
    setScheduledAt(
      slotTime ? `${socialCalendarDateKey(date)}T${slotTime}` : scheduleTimeForDate(date),
    );
    setComposeOpen(true);
  };

  const openPostForEdit = (post: SchedulerPost) => {
    if (data?.locked || !RESCHEDULABLE_POST_STATUSES.has(post.status)) return;
    resetComposeForm();
    const settings = Object.fromEntries(
      post.targets.map((target) => [target.provider, target.providerSettings || {}]),
    ) as SocialProviderSettings;
    const tiktok = settings.tiktok || {};
    const youtube = settings.youtube || {};
    const instagram = settings.instagram || {};
    const reddit = settings.reddit || {};
    setEditingPostId(post.id);
    setSavedProviderSettings(settings);
    setBody(post.body);
    setTitle(post.title || "");
    setMedia(post.media);
    setSelected(post.targets.map((target) => target.connectionId));
    setPreviewConnectionId(post.targets[0]?.connectionId || "");
    setScheduledAt(
      post.scheduledAt
        ? isoToZonedDateTimeInput(post.scheduledAt, schedulerTimeZone)
        : defaultScheduleInput(schedulerTimeZone),
    );
    if (typeof tiktok.privacyLevel === "string") setTiktokPrivacy(tiktok.privacyLevel);
    setTiktokAllowComment(tiktok.disableComment === false);
    setTiktokAllowDuet(tiktok.disableDuet === false);
    setTiktokAllowStitch(tiktok.disableStitch === false);
    setTiktokCommercial(tiktok.commercialContent === true);
    setTiktokOwnBrand(tiktok.brandOrganicToggle === true);
    setTiktokBrandedContent(tiktok.brandContentToggle === true);
    setTiktokAiGenerated(tiktok.isAigc === true);
    if (typeof tiktok.videoCoverTimestampMs === "number")
      setTiktokCoverMs(tiktok.videoCoverTimestampMs);
    if (typeof youtube.youtubePrivacy === "string") setYoutubePrivacy(youtube.youtubePrivacy);
    if (typeof youtube.description === "string") setYoutubeDescription(youtube.description);
    setInstagramTrialReel(instagram.trialReel === true);
    if (
      instagram.graduationStrategy === "MANUAL" ||
      instagram.graduationStrategy === "SS_PERFORMANCE"
    ) {
      setInstagramGraduationStrategy(instagram.graduationStrategy);
    }
    if (typeof reddit.community === "string") setRedditCommunity(reddit.community);
    if (reddit.kind === "link" || reddit.kind === "self") setRedditKind(reddit.kind);
    if (settings.twitter?.kind === "article") setXPostKind("article");
    if (typeof reddit.url === "string") setRedditUrl(reddit.url);
    setComposeOpen(true);
  };

  const selectedConnections = useMemo<SchedulerConnection[]>(
    () =>
      (data?.connections || []).filter((connection: SchedulerConnection) =>
        selected.includes(connection.id),
      ),
    [data?.connections, selected],
  );
  const connectedProviders = selectedConnections.map((connection) => connection.provider);
  const selectedXConnection = selectedConnections.find(
    (connection) => connection.provider === "twitter",
  );
  const xArticle = Boolean(selectedXConnection && xPostKind === "article");
  const usesCaption = schedulerUsesCaption(connectedProviders);
  const captionLimit = schedulerCaptionLimit(
    connectedProviders,
    selectedXConnection?.xCapabilities,
  );
  const hasVideo = media.some((item) => item.mimeType.startsWith("video/"));
  const primaryVideo = media.find((item) => item.mimeType.startsWith("video/")) || null;
  const needsYouTubeTitle = connectedProviders.includes("youtube");
  const tiktokSelected = connectedProviders.includes("tiktok");
  const selectedTikTokConnectionIds = useMemo(
    () =>
      selectedConnections
        .filter((connection) => connection.provider === "tiktok")
        .map((connection) => connection.id)
        .sort(),
    [selectedConnections],
  );
  const tiktokCreatorInfo = useQuery({
    queryKey: ["tiktok-creator-info", selectedTikTokConnectionIds],
    queryFn: () => getTikTokCreatorInfo({ data: { connectionIds: selectedTikTokConnectionIds } }),
    enabled: composeOpen && selectedTikTokConnectionIds.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
  const tiktokPrivacyOptions = useMemo(() => {
    const creators = tiktokCreatorInfo.data || [];
    if (!creators.length) return [];
    return creators
      .slice(1)
      .reduce(
        (options, creator) =>
          options.filter((option: string) => creator.privacyLevelOptions.includes(option)),
        [...creators[0].privacyLevelOptions],
      );
  }, [tiktokCreatorInfo.data]);
  const tiktokInteractionDisabled = useMemo(
    () => ({
      comment: Boolean(tiktokCreatorInfo.data?.some((creator) => creator.commentDisabled)),
      duet: Boolean(tiktokCreatorInfo.data?.some((creator) => creator.duetDisabled)),
      stitch: Boolean(tiktokCreatorInfo.data?.some((creator) => creator.stitchDisabled)),
    }),
    [tiktokCreatorInfo.data],
  );
  const tiktokMaxVideoDurationSec = useMemo(() => {
    const durations = (tiktokCreatorInfo.data || [])
      .map((creator) => creator.maxVideoPostDurationSec)
      .filter((duration) => duration > 0);
    return durations.length ? Math.min(...durations) : 0;
  }, [tiktokCreatorInfo.data]);
  useEffect(() => {
    if (
      tiktokPrivacy &&
      tiktokPrivacyOptions.length &&
      !tiktokPrivacyOptions.includes(tiktokPrivacy)
    ) {
      setTiktokPrivacy("");
    }
  }, [tiktokPrivacy, tiktokPrivacyOptions]);
  useEffect(() => {
    if (tiktokInteractionDisabled.comment) setTiktokAllowComment(false);
    if (tiktokInteractionDisabled.duet) setTiktokAllowDuet(false);
    if (tiktokInteractionDisabled.stitch) setTiktokAllowStitch(false);
  }, [tiktokInteractionDisabled]);
  useEffect(() => {
    if (tiktokPrivacy === "SELF_ONLY") setTiktokBrandedContent(false);
  }, [tiktokPrivacy]);
  const youtubeFormat = needsYouTubeTitle ? youtubeDetectedFormat(videoMeta) : null;
  const instagramReelCover =
    connectedProviders.includes("instagram") && hasVideo && media.length === 1;
  const videoDurationMs =
    videoMeta && Number.isFinite(videoMeta.durationSeconds) && videoMeta.durationSeconds > 0
      ? Math.floor(videoMeta.durationSeconds * 1_000)
      : 0;
  useEffect(() => {
    let cancelled = false;
    if (!primaryVideo?.url) {
      setVideoMeta(null);
      return;
    }
    setVideoMeta(null);
    const el = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    el.src = primaryVideo.url;
    const fallbackMeta = { durationSeconds: 61, width: 1920, height: 1080 };
    const apply = (meta: YouTubeVideoMeta) => {
      if (!cancelled) setVideoMeta(meta);
    };
    const onMeta = () => {
      const durationSeconds = el.duration;
      const width = el.videoWidth;
      const height = el.videoHeight;
      if (Number.isFinite(durationSeconds) && durationSeconds > 0 && width > 0 && height > 0) {
        apply({ durationSeconds, width, height });
      } else {
        apply(fallbackMeta);
      }
    };
    const onError = () => apply(fallbackMeta);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onError);
    return () => {
      cancelled = true;
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onError);
      el.removeAttribute("src");
      el.load();
    };
  }, [primaryVideo?.url]);
  const selectedRedditConnection = useMemo(
    () => selectedConnections.find((connection) => connection.provider === "reddit"),
    [selectedConnections],
  );
  const redditCommunities = useQuery({
    queryKey: ["reddit-communities", selectedRedditConnection?.id],
    queryFn: () => getRedditCommunities({ data: { connectionId: selectedRedditConnection!.id } }),
    enabled: Boolean(selectedRedditConnection?.id),
    staleTime: 15 * 60_000,
    retry: 1,
  });
  const providerSettings = useMemo(
    () => ({
      tiktok: {
        ...savedProviderSettings.tiktok,
        privacyLevel: tiktokPrivacy,
        disableComment: !tiktokAllowComment,
        disableDuet: !tiktokAllowDuet,
        disableStitch: !tiktokAllowStitch,
        commercialContent: tiktokCommercial,
        brandOrganicToggle: tiktokCommercial && tiktokOwnBrand,
        brandContentToggle: tiktokCommercial && tiktokBrandedContent,
        isAigc: tiktokAiGenerated,
        videoDurationSeconds: videoMeta?.durationSeconds || 0,
        maxVideoPostDurationSec: tiktokMaxVideoDurationSec,
        videoCoverTimestampMs: videoDurationMs
          ? clampTikTokCoverTimestampMs(tiktokCoverMs, videoDurationMs)
          : tiktokCoverMs,
      },
      youtube: {
        ...savedProviderSettings.youtube,
        youtubePrivacy,
        ...(youtubeFormat ? { youtubeFormat } : {}),
        ...(usesCaption && youtubeDescription.trim() ? { description: youtubeDescription } : {}),
        ...(hasVideo && youtubeThumbnail
          ? { thumbnail: pendingThumbnailMedia(youtubeThumbnail) }
          : {}),
      },
      instagram: {
        ...savedProviderSettings.instagram,
        trialReel: instagramReelCover && instagramTrialReel,
        graduationStrategy: instagramGraduationStrategy,
        ...(instagramReelCover && instagramCover
          ? { cover: pendingThumbnailMedia(instagramCover) }
          : {}),
      },
      reddit: {
        ...savedProviderSettings.reddit,
        community: redditCommunity,
        kind: redditKind,
        url: redditUrl,
      },
      twitter: {
        ...savedProviderSettings.twitter,
        kind: xPostKind,
      },
    }),
    [
      hasVideo,
      instagramCover,
      instagramGraduationStrategy,
      instagramReelCover,
      instagramTrialReel,
      redditCommunity,
      redditKind,
      redditUrl,
      xPostKind,
      savedProviderSettings,
      tiktokAiGenerated,
      tiktokAllowComment,
      tiktokAllowDuet,
      tiktokAllowStitch,
      tiktokBrandedContent,
      tiktokCommercial,
      tiktokCoverMs,
      tiktokMaxVideoDurationSec,
      tiktokOwnBrand,
      tiktokPrivacy,
      usesCaption,
      videoDurationMs,
      youtubeDescription,
      youtubeFormat,
      youtubePrivacy,
      youtubeThumbnail,
      videoMeta?.durationSeconds,
    ],
  );
  const youtubeThumbnailMedia = pendingThumbnailMedia(youtubeThumbnail);
  const instagramCoverMedia = pendingThumbnailMedia(instagramCover);
  const composeFingerprint = schedulerComposeFingerprint({
    body,
    title,
    scheduledAt,
    selected,
    media,
    providerSettings,
  });
  useEffect(() => {
    if (!composeOpen) {
      initialComposeFingerprintRef.current = null;
      return;
    }
    initialComposeFingerprintRef.current ??= composeFingerprint;
  }, [composeFingerprint, composeOpen]);
  const composeDirty =
    initialComposeFingerprintRef.current !== null &&
    initialComposeFingerprintRef.current !== composeFingerprint;
  const requestComposeClose = () => {
    if (composeDirty) {
      setDiscardPromptOpen(true);
      return;
    }
    closeCompose();
  };
  const providerErrors = validatePostForProviders(
    body,
    media,
    connectedProviders,
    title,
    providerSettings,
    selectedXConnection?.xCapabilities,
  );
  const mediaCompatibility = schedulerMediaCompatibility(connectedProviders);
  const needsRedditFields = connectedProviders.includes("reddit");
  const needsPostTitle = needsYouTubeTitle || needsRedditFields || xArticle;
  const previewConnection =
    selectedConnections.find((connection) => connection.id === previewConnectionId) ||
    selectedConnections[0] ||
    null;

  const save = useMutation({
    mutationFn: ({
      publishNow,
      asDraft = false,
      scheduledAtOverride,
    }: {
      publishNow: boolean;
      asDraft?: boolean;
      scheduledAtOverride?: string;
    }) => {
      const scheduledIso =
        scheduledAtOverride || zonedDateTimeInputToIso(scheduledAt, schedulerTimeZone);
      if (!publishNow && !asDraft && !scheduledIso) throw new Error("Choose a valid publish time.");
      return Promise.all([
        materializeThumbnail(youtubeThumbnail, "youtube"),
        materializeThumbnail(instagramCover, "instagram"),
      ]).then(([uploadedYoutubeThumbnail, uploadedInstagramCover]) =>
        saveSocialPost({
          data: {
            id: editingPostId || undefined,
            body,
            title,
            scheduledAt: publishNow || asDraft ? null : scheduledIso,
            timezone: schedulerTimeZone,
            connectionIds: selected,
            media,
            providerSettings: {
              ...providerSettings,
              youtube: {
                ...providerSettings.youtube,
                ...(uploadedYoutubeThumbnail ? { thumbnail: uploadedYoutubeThumbnail } : {}),
              },
              instagram: {
                ...providerSettings.instagram,
                ...(uploadedInstagramCover ? { cover: uploadedInstagramCover } : {}),
              },
            },
            publishNow,
            asDraft,
          },
        }),
      );
    },
    onSuccess: (next, { asDraft, publishNow }) => {
      queryClient.setQueryData(["social-scheduler"], next);
      closeCompose();
      if (publishNow && next.queuedPostId) {
        setPublishingPostId(next.queuedPostId);
        toast.success("Added to publishing queue", {
          description: "Bento will update this post as soon as the platforms respond.",
        });
      } else {
        toast.success(asDraft ? "Draft saved" : editingPostId ? "Post updated" : "Post scheduled");
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save post"),
  });

  const publishingNow = save.isPending && save.variables?.publishNow === true;

  useEffect(() => {
    if (!publishingPostId) return;
    const post = data?.posts.find((item: SchedulerPost) => item.id === publishingPostId);
    if (!post) return;
    if (post.status === "published") {
      toast.success("Post published");
      setPublishingPostId(null);
    } else if (["failed", "partially_failed"].includes(post.status)) {
      toast.error(post.status === "failed" ? "Post could not be published" : "Some posts failed");
      setPublishingPostId(null);
    }
  }, [data?.posts, publishingPostId]);

  const saveSchedule = useMutation({
    mutationFn: (schedule: PostingSchedule) => savePostingSchedule({ data: schedule }),
    onSuccess: (next) => {
      queryClient.setQueryData(["social-scheduler"], next);
      setPostingSettingsOpen(false);
      toast.success("Posting times saved");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save posting times"),
  });

  const scheduleAtNextSlot = () => {
    const postingSchedule = data?.postingSchedule;
    if (!postingSchedule?.slots.length) {
      setPostingSettingsOpen(true);
      toast.error("Add a posting time first.");
      return;
    }
    const occupied = (data?.posts || [])
      .filter((post: SchedulerPost) => post.status === "scheduled" && post.scheduledAt)
      .map((post: SchedulerPost) => post.scheduledAt!);
    const offset = postingSchedule.naturalOffset ? Math.floor(Math.random() * 9) - 4 : 0;
    const nextSlot = nextPostingSlot(
      postingSchedule.slots,
      postingSchedule.timezone,
      new Date(),
      occupied,
      offset,
    );
    if (!nextSlot) {
      toast.error("No open posting slot was found.");
      return;
    }
    save.mutate({ publishNow: false, scheduledAtOverride: nextSlot });
  };

  const cancel = useMutation({
    mutationFn: (id: string) => cancelSocialPost({ data: { id } }),
    onSuccess: (next) => queryClient.setQueryData(["social-scheduler"], next),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not cancel post"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSocialPost({ data: { id } }),
    onSuccess: (next) => queryClient.setQueryData(["social-scheduler"], next),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not delete post"),
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => duplicateSocialPost({ data: { id } }),
    onSuccess: (next) => {
      queryClient.setQueryData(["social-scheduler"], next);
      toast.success("Post duplicated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not duplicate post"),
  });
  const reschedule = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: string; scheduledAt: string }) =>
      rescheduleSocialPost({
        data: {
          id,
          scheduledAt,
          timezone: schedulerTimeZone,
        },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(["social-scheduler"], next);
      toast.success("Post rescheduled");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not reschedule post"),
  });

  async function uploadFiles(files: readonly File[]) {
    setUploadError(null);
    if (mediaCompatibility.disabled) {
      const message = mediaCompatibility.summary;
      setUploadError(message);
      toast.error(message);
      return;
    }
    if (media.length >= mediaCompatibility.maxMedia) {
      const message = mediaCompatibility.summary;
      setUploadError(message);
      toast.error(message);
      return;
    }
    if (!files.length) {
      const message = "No file was selected.";
      setUploadError(message);
      toast.error(message);
      return;
    }
    const selection = prepareSchedulerMediaFiles(
      files,
      media.length,
      mediaCompatibility.maxMedia,
      mediaCompatibility.allowedKinds,
      mediaCompatibility.allowedMimeTypes,
    );
    if (!selection.accepted.length) {
      const message =
        media.length >= mediaCompatibility.maxMedia
          ? mediaCompatibility.summary
          : `Choose a supported ${mediaCompatibility.allowedKinds.join(" or ")} file.`;
      setUploadError(message);
      toast.error(message);
      return;
    }

    const plan = (data as { plan?: "free" | "store" | "creator" } | undefined)?.plan || "creator";
    for (const file of selection.accepted) {
      const kind =
        file.type.startsWith("video/") || schedulerMediaKindForFile(file) === "video"
          ? "video"
          : schedulerMediaKindForFile(file) === "file"
            ? "file"
            : "image";
      const maxMb = uploadLimitMb(kind, plan);
      if (file.size > maxMb * 1024 * 1024) {
        const message = `${kind === "video" ? "Videos" : kind === "file" ? "Files" : "Images"} are limited to ${maxMb} MB on your plan.`;
        setUploadError(message);
        toast.error(message);
        return;
      }
      if (file.size <= 0) {
        const message = "That file looks empty. Pick another video and try again.";
        setUploadError(message);
        toast.error(message);
        return;
      }
    }

    setUploading(true);
    try {
      const results = await Promise.allSettled(
        selection.accepted.map(async (file) => {
          if (file.type.startsWith("video/") || schedulerMediaKindForFile(file) === "video") {
            return uploadFileResult(file, "video", { optimize: false });
          }
          if (
            file.type === "application/pdf" ||
            file.type === "application/msword" ||
            file.type.includes("wordprocessingml") ||
            file.type.includes("presentationml") ||
            file.type === "application/vnd.ms-powerpoint" ||
            schedulerMediaKindForFile(file) === "file"
          ) {
            return uploadFileResult(file, "file", { optimize: false });
          }
          const prepared = await prepareSchedulerImageUpload(file);
          return uploadFileResult(prepared, "image", { optimize: false });
        }),
      );
      const uploaded = results
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof uploadFileResult>>> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value)
        .filter((item) => Boolean(item.publicUrl));
      setMedia((current) => [
        ...current,
        ...uploaded.map((item) => ({ ...item, url: item.publicUrl || "" })),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : "Upload failed"]
          : [],
      );
      const failedCount = failures.length + (results.length - uploaded.length - failures.length);
      if (failedCount || selection.rejectedCount || selection.overflowCount) {
        const skipped = failedCount + selection.rejectedCount + selection.overflowCount;
        const message =
          failures[0] ||
          `${uploaded.length} file${uploaded.length === 1 ? "" : "s"} uploaded. ${skipped} could not be added.`;
        setUploadError(message);
        toast.error(message);
      } else if (uploaded.length) {
        setUploadError(null);
        toast.success(
          `${uploaded.length} file${uploaded.length === 1 ? "" : "s"} added to this post.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setUploadError(message);
      toast.error(message);
    } finally {
      setUploading(false);
    }
  }

  function openMediaPicker() {
    if (uploading) return;
    if (mediaCompatibility.disabled) {
      toast.error(mediaCompatibility.summary);
      return;
    }
    if (media.length >= mediaCompatibility.maxMedia) {
      toast.error(mediaCompatibility.summary);
      return;
    }
    mediaInputRef.current?.click();
  }

  async function prepareCoverImage(file: File | undefined, target: "youtube" | "instagram") {
    if (!file) return;
    if (schedulerMediaKindForFile(file) !== "image") {
      const message = "Choose a JPEG, PNG, or WebP image for the cover.";
      toast.error(message);
      return;
    }
    const plan = (data as { plan?: "free" | "store" | "creator" } | undefined)?.plan || "creator";
    const maxMb = uploadLimitMb("image", plan);
    if (file.size > maxMb * 1024 * 1024) {
      toast.error(`Images are limited to ${maxMb} MB on your plan.`);
      return;
    }
    setUploading(true);
    try {
      const prepared = await prepareSchedulerImageUpload(file);
      if (target === "youtube" && prepared.size > YOUTUBE_THUMBNAIL_MAX_BYTES) {
        toast.error("YouTube thumbnails must be 2 MB or smaller.");
        return;
      }
      replacePendingThumbnail(target, {
        previewUrl: URL.createObjectURL(prepared),
        file: prepared,
        uploaded: null,
      });
      toast.success("Thumbnail ready");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not prepare the cover");
    } finally {
      setUploading(false);
    }
  }

  async function selectVideoFrame(
    video: HTMLVideoElement,
    timestampMs: number,
    target: "youtube" | "instagram",
  ) {
    setUploading(true);
    try {
      const file = await captureVideoFrame(video, timestampMs);
      replacePendingThumbnail(target, {
        previewUrl: URL.createObjectURL(file),
        file,
        uploaded: null,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not capture this video frame");
    } finally {
      setUploading(false);
    }
  }

  async function materializeThumbnail(
    value: PendingThumbnail | null,
    target: "youtube" | "instagram",
  ) {
    if (!value) return null;
    if (value.uploaded) return value.uploaded;
    if (!value.file) return null;
    setUploading(true);
    try {
      const uploaded = await uploadFileResult(value.file, "image", { optimize: false });
      if (!uploaded.publicUrl) throw new Error("Upload failed");
      const item = { ...uploaded, url: uploaded.publicUrl };
      replacePendingThumbnail(target, { ...value, uploaded: item });
      return item;
    } finally {
      setUploading(false);
    }
  }

  const canSubmit =
    selected.length > 0 &&
    (body.trim().length > 0 || media.length > 0 || (redditKind === "link" && redditUrl.trim())) &&
    (!needsPostTitle || title.trim().length > 0) &&
    Object.keys(providerErrors).length === 0 &&
    !save.isPending &&
    !(primaryVideo && !videoMeta && (needsYouTubeTitle || tiktokSelected)) &&
    (!tiktokSelected || (tiktokCreatorInfo.isSuccess && tiktokPrivacyOptions.length > 0));

  const sortedPosts = useMemo(
    () =>
      ((data?.posts || []) as SchedulerPost[])
        .filter((post) =>
          ["draft", "scheduled", "publishing", "published", "partially_failed", "failed"].includes(
            post.status,
          ),
        )
        .sort(
          (left, right) =>
            new Date(right.scheduledAt || right.createdAt).getTime() -
            new Date(left.scheduledAt || left.createdAt).getTime(),
        ),
    [data?.posts],
  );
  const draftPosts = sortedPosts.filter((post) => post.status === "draft");
  const timelinePosts = sortedPosts.filter((post) => post.status !== "draft");

  return (
    <main className={`relative overflow-x-clip ${micro.shell}`}>
      <AppHeader
        title="Social scheduler"
        actions={
          <button
            type="button"
            onClick={openNewPost}
            disabled={isLoading || isError || !!data?.locked}
            aria-label="Create new post"
            className={`${micro.btnPrimaryCompact} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0`}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Create new post</span>
          </button>
        }
      />

      <div className={micro.main}>
        <MicroAppTabMotion tabKey="scheduler" className="mt-0">
          {isLoading ? (
            <div className="flex min-h-[50vh] items-center justify-center">
              <LoaderCircle className="size-8 animate-spin text-primary" />
            </div>
          ) : isError ? (
            <MicroAppPanel>
              <p className="text-sm text-rose-600">
                The scheduler could not load. Please refresh and try again.
              </p>
            </MicroAppPanel>
          ) : (
            <div className="space-y-6">
              {data?.locked && (
                <MicroAppPanel className="text-center">
                  <div className={`mx-auto size-14 ${micro.iconWell}`}>
                    <CalendarClock className="size-6" />
                  </div>
                  <h2 className="mt-5 font-ui-display text-3xl">Plan every channel together</h2>
                  <p className={`mx-auto mt-2 max-w-lg ${micro.muted}`}>
                    The post scheduler is included with Creator. Your existing posts remain below,
                    but creating or editing posts requires Creator.
                  </p>
                  <div className="mt-6 flex justify-center">
                    <UpgradeDialog feature="postScheduler" />
                  </div>
                </MicroAppPanel>
              )}

              <SchedulerCalendarView
                posts={(data?.posts || []) as SchedulerPost[]}
                connections={(data?.connections || []) as SchedulerConnection[]}
                postingSchedule={data?.postingSchedule}
                canCreate={!data?.locked}
                canReschedule={!data?.locked}
                onCreateForDate={openComposeForDate}
                onEditPost={openPostForEdit}
                onDuplicatePost={(post) => duplicate.mutate(post.id)}
                onDeletePost={(post) => {
                  if (!window.confirm("Delete this post from your calendar?")) return;
                  if (post.status === "scheduled") {
                    cancel.mutate(post.id, {
                      onSuccess: () => toast.success("Post deleted from the calendar"),
                    });
                  } else {
                    remove.mutate(post.id, { onSuccess: () => toast.success("Post deleted") });
                  }
                }}
                onOpenPostingSettings={() => setPostingSettingsOpen(true)}
                onReschedule={(id, nextScheduledAt) =>
                  reschedule.mutate({ id, scheduledAt: nextScheduledAt })
                }
                onAvatarError={repairAvatar}
              />

              <MicroAppPanel>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={micro.eyebrow}>Saved</p>
                    <h2 className="mt-1 font-ui-display text-xl sm:text-2xl">Drafts</h2>
                  </div>
                  <span className={`${micro.soft} px-3 py-1.5 text-xs font-semibold tabular-nums`}>
                    {draftPosts.length}
                  </span>
                </div>
                <div className="mt-5 space-y-3">
                  {draftPosts.length ? (
                    draftPosts.map((post) => (
                      <PostRow
                        key={post.id}
                        post={post}
                        canEdit={!data?.locked}
                        onCancel={() => cancel.mutate(post.id)}
                        onDuplicate={() => duplicate.mutate(post.id)}
                        onDelete={() => remove.mutate(post.id)}
                      />
                    ))
                  ) : (
                    <div className={`${micro.empty} py-8 text-sm text-muted-foreground`}>
                      Saved drafts will appear here.
                    </div>
                  )}
                </div>
              </MicroAppPanel>

              <MicroAppPanel>
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={micro.eyebrow}>Posts</p>
                    <h2 className="mt-1 font-ui-display text-xl sm:text-2xl">
                      Scheduled &amp; published
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void queryClient.invalidateQueries({ queryKey: ["social-scheduler"] })
                    }
                    className={`${micro.btnSoft} size-10 px-0`}
                    aria-label="Refresh posts"
                  >
                    <RefreshCw className="size-4" />
                  </button>
                </div>
                <div className="mt-5 space-y-3">
                  {timelinePosts.length ? (
                    timelinePosts.map((post) => (
                      <PostRow
                        key={post.id}
                        post={post}
                        canEdit={!data?.locked}
                        onCancel={() => cancel.mutate(post.id)}
                        onDuplicate={() => duplicate.mutate(post.id)}
                        onDelete={() => remove.mutate(post.id)}
                      />
                    ))
                  ) : (
                    <div className={`${micro.empty} py-8 text-sm text-muted-foreground`}>
                      Tap + on a day to schedule your first post.
                    </div>
                  )}
                </div>
              </MicroAppPanel>

              <Dialog
                open={composeOpen}
                onOpenChange={(open) => {
                  if (open) setComposeOpen(true);
                  else requestComposeClose();
                }}
              >
                <DialogContent
                  overlayClassName="bg-[#17213a]/35 backdrop-blur-[6px]"
                  className="h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-6xl gap-0 overflow-hidden rounded-[24px] border-white/80 bg-[#f7f8fc] p-0 shadow-[0_42px_130px_-45px_rgba(23,33,58,.7)] data-[state=closed]:slide-out-to-bottom-2 data-[state=open]:slide-in-from-bottom-2 sm:h-[min(92dvh,860px)] sm:rounded-[32px] [&>button]:z-40"
                >
                  <div className="flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto sm:overflow-hidden">
                    <div className="shrink-0 border-b border-border/70 px-5 py-3 pr-14 sm:px-7">
                      <DialogTitle className="font-ui-display text-2xl sm:text-3xl">
                        {editingPostId ? "Edit post" : "Create a post"}
                      </DialogTitle>
                    </div>

                    <div className="min-h-0 flex-none overflow-visible px-5 py-5 sm:flex-1 sm:overflow-y-auto sm:px-7 sm:py-6 lg:overflow-hidden">
                      <div className="grid gap-6 lg:h-full lg:min-h-0 lg:grid-cols-2 lg:items-stretch lg:gap-0">
                        <div
                          data-testid="scheduler-compose-scroll"
                          className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pr-8"
                        >
                          <div className="flex min-h-10 flex-wrap items-center gap-2">
                            {(data?.connections || []).map((connection: SchedulerConnection) => (
                              <AccountChip
                                key={connection.id}
                                connection={connection}
                                selected={selected.includes(connection.id)}
                                onToggle={() =>
                                  setSelected((current) =>
                                    current.includes(connection.id)
                                      ? current.filter((id) => id !== connection.id)
                                      : [...current, connection.id],
                                  )
                                }
                              />
                            ))}
                            {!data?.connections.length && (
                              <p className="text-sm text-muted-foreground">
                                Connect your social accounts in Settings → Integrations.
                              </p>
                            )}
                          </div>

                          {selectedXConnection && (
                            <div className="mt-5 rounded-2xl border border-border/70 bg-white p-4">
                              <p className="text-xs font-semibold text-muted-foreground">
                                X format
                              </p>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  aria-pressed={xPostKind === "post"}
                                  onClick={() => setXPostKind("post")}
                                  className={xPostKind === "post" ? micro.btnInk : micro.btnSoft}
                                >
                                  Post
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={xPostKind === "article"}
                                  onClick={() => setXPostKind("article")}
                                  disabled={
                                    selectedConnections.length !== 1 ||
                                    !selectedXConnection.xCapabilities?.canPublishArticles
                                  }
                                  className={xPostKind === "article" ? micro.btnInk : micro.btnSoft}
                                >
                                  Article
                                </button>
                              </div>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {selectedXConnection.xCapabilities?.canPostLong
                                  ? "This X account can publish posts up to 25,000 characters."
                                  : "X Premium status is unavailable or this account has a 280-character limit."}
                                {selectedXConnection.xCapabilities?.canPublishArticles
                                  ? " Text-only Articles are available when X is the only destination."
                                  : " Articles require X Premium, Premium+, or an eligible organization account."}
                              </p>
                            </div>
                          )}

                          {needsPostTitle && (
                            <label className="mt-6 block">
                              <span className="flex items-end justify-between gap-3">
                                <span className="text-xs font-semibold text-muted-foreground">
                                  {xArticle
                                    ? "Article title"
                                    : needsYouTubeTitle && needsRedditFields
                                      ? "Post title"
                                      : needsYouTubeTitle
                                        ? "YouTube title"
                                        : "Reddit title"}
                                </span>
                                <span className="text-[11px] tabular-nums text-muted-foreground">
                                  {title.length}/
                                  {xArticle || (needsRedditFields && !needsYouTubeTitle)
                                    ? 300
                                    : 100}
                                </span>
                              </span>
                              <input
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                maxLength={
                                  xArticle || (needsRedditFields && !needsYouTubeTitle) ? 300 : 100
                                }
                                placeholder={
                                  xArticle
                                    ? "Give your Article a title"
                                    : youtubeFormat === "short"
                                      ? "A short title for the Shorts feed"
                                      : needsYouTubeTitle
                                        ? "Give your video a clear title"
                                        : "Write a clear title"
                                }
                                className={`mt-2 ${micro.input}`}
                              />
                              {youtubeFormat === "short" && (
                                <span className="mt-2 block text-[11px] leading-4 text-muted-foreground">
                                  The Shorts feed truncates long titles.
                                </span>
                              )}
                            </label>
                          )}

                          <label className="mt-6 block">
                            <span className="flex items-end justify-between gap-3">
                              <span
                                className={
                                  connectedProviders.length
                                    ? "text-xs font-semibold text-muted-foreground"
                                    : "sr-only"
                                }
                              >
                                {xArticle
                                  ? "Article body"
                                  : usesCaption
                                    ? schedulerCaptionLabel(connectedProviders)
                                    : needsYouTubeTitle
                                      ? "Description"
                                      : "Post text"}
                              </span>
                              {connectedProviders.length > 0 && (
                                <span className="text-[11px] tabular-nums text-muted-foreground">
                                  {body.length.toLocaleString()}/
                                  {(usesCaption ? captionLimit : 5_000).toLocaleString()}
                                </span>
                              )}
                            </span>
                            <textarea
                              value={body}
                              onChange={(event) => setBody(event.target.value)}
                              rows={7}
                              placeholder={
                                xArticle
                                  ? "Write your X Article"
                                  : schedulerCaptionPlaceholder(connectedProviders)
                              }
                              className="mt-2 w-full resize-none bg-transparent font-ui-sans text-[26px] leading-relaxed outline-none placeholder:text-muted-foreground/45 sm:text-[32px]"
                            />
                          </label>

                          {needsYouTubeTitle && usesCaption && (
                            <label className="mt-5 block">
                              <span className="flex items-end justify-between gap-3">
                                <span className="text-xs font-semibold text-muted-foreground">
                                  YouTube description
                                </span>
                                <span className="text-[11px] tabular-nums text-muted-foreground">
                                  {youtubeDescription.length.toLocaleString()}/5,000
                                </span>
                              </span>
                              <textarea
                                value={youtubeDescription}
                                onChange={(event) => setYoutubeDescription(event.target.value)}
                                rows={5}
                                maxLength={5_000}
                                placeholder="Defaults to your caption if left blank"
                                className={`mt-2 min-h-32 ${micro.input}`}
                              />
                            </label>
                          )}

                          {needsRedditFields && (
                            <div
                              className={`mt-5 grid gap-4 border border-black/[0.08] p-4 sm:grid-cols-2 ${micro.soft}`}
                            >
                              <label className="block">
                                <span className="text-xs font-semibold text-muted-foreground">
                                  Community
                                </span>
                                <div className="mt-2 flex items-center rounded-2xl border border-black/[0.08] bg-[#f8faff] px-4 focus-within:border-[#3478f6]/45">
                                  <span className="text-sm text-muted-foreground">r/</span>
                                  <input
                                    list="reddit-community-options"
                                    value={redditCommunity}
                                    onChange={(event) =>
                                      setRedditCommunity(event.target.value.replace(/^r\//i, ""))
                                    }
                                    maxLength={21}
                                    placeholder="creators"
                                    className="min-w-0 flex-1 bg-transparent px-1 py-3 text-sm outline-none"
                                  />
                                  <datalist id="reddit-community-options">
                                    {(redditCommunities.data || []).map((community) => (
                                      <option key={community.name} value={community.name}>
                                        {community.title}
                                      </option>
                                    ))}
                                  </datalist>
                                </div>
                                <span className="mt-2 block text-[11px] leading-4 text-muted-foreground">
                                  {redditCommunities.isLoading
                                    ? "Loading your Reddit communities…"
                                    : redditCommunities.isError
                                      ? "Communities could not load. Reconnect Reddit or type a public community."
                                      : redditCommunities.data?.length
                                        ? `${redditCommunities.data.length} joined communities available. Bento verifies access before saving.`
                                        : "Type a public community. Bento verifies it before saving."}
                                </span>
                              </label>
                              <label className="block">
                                <span className="text-xs font-semibold text-muted-foreground">
                                  Post type
                                </span>
                                <select
                                  value={redditKind}
                                  onChange={(event) =>
                                    setRedditKind(event.target.value as "self" | "link")
                                  }
                                  className={`mt-2 ${micro.input}`}
                                >
                                  <option value="self">Text post</option>
                                  <option value="link">Link post</option>
                                </select>
                              </label>
                              {redditKind === "link" && (
                                <label className="block sm:col-span-2">
                                  <span className="text-xs font-semibold text-muted-foreground">
                                    Link URL
                                  </span>
                                  <input
                                    value={redditUrl}
                                    onChange={(event) => setRedditUrl(event.target.value)}
                                    inputMode="url"
                                    placeholder="https://example.com"
                                    className={`mt-2 ${micro.input}`}
                                  />
                                </label>
                              )}
                            </div>
                          )}

                          {media.length > 0 && (
                            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                              {media.map((item) => (
                                <div
                                  key={item.key}
                                  className={`group relative aspect-square overflow-hidden ${micro.soft}`}
                                >
                                  {item.mimeType.startsWith("video/") ? (
                                    <video
                                      src={item.url}
                                      className="size-full object-cover"
                                      muted
                                      playsInline
                                    />
                                  ) : isSchedulerDocument(item.mimeType) ? (
                                    <div className="flex size-full flex-col items-center justify-center gap-1 bg-zinc-900 px-2 text-center text-[10px] text-white/80">
                                      <span className="uppercase tracking-[0.14em] text-white/55">
                                        Doc
                                      </span>
                                      <span className="line-clamp-3">{item.name}</span>
                                    </div>
                                  ) : (
                                    <DecodedImage
                                      src={item.url}
                                      alt=""
                                      className="size-full object-cover"
                                    />
                                  )}
                                  <button
                                    type="button"
                                    aria-label={`Remove ${item.name}`}
                                    onClick={() =>
                                      setMedia((current) =>
                                        current.filter((mediaItem) => mediaItem.key !== item.key),
                                      )
                                    }
                                    className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur"
                                  >
                                    <X className="size-4" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {hasVideo &&
                            (needsYouTubeTitle ||
                              instagramReelCover ||
                              connectedProviders.includes("tiktok")) && (
                              <div className="mt-5 space-y-3">
                                <p className={micro.eyebrowMuted}>Thumbnails</p>
                                {needsYouTubeTitle && (
                                  <ProviderComposeCard
                                    provider="youtube"
                                    title={youtubeFormat === "short" ? "YouTube Short" : "YouTube"}
                                    hint={
                                      youtubeFormat === "short"
                                        ? "Vertical or square, up to 3 minutes. Same upload as a regular video."
                                        : youtubeFormat === "video"
                                          ? "Custom thumbnail and visibility"
                                          : "Reading this video to see if YouTube will treat it as a Short."
                                    }
                                  >
                                    {youtubeFormat === "short" && (
                                      <p className="text-xs leading-5 text-muted-foreground">
                                        YouTube will treat this file as a Short. A custom thumbnail
                                        still helps on your channel, search, and shares. The Shorts
                                        feed plays the video instead of this image.
                                      </p>
                                    )}
                                    <CoverImagePicker
                                      label="Thumbnail"
                                      hint={
                                        youtubeFormat === "short"
                                          ? "9:16 JPEG, up to 2 MB. 1080×1920 works best for Shorts."
                                          : "16:9 JPEG, up to 2 MB. Channels must be allowed to upload custom thumbnails."
                                      }
                                      aspect={youtubeFormat === "short" ? "portrait" : "video"}
                                      image={youtubeThumbnailMedia}
                                      uploading={uploading}
                                      onPick={() => youtubeThumbInputRef.current?.click()}
                                      onRemove={() => replacePendingThumbnail("youtube", null)}
                                    />
                                    <input
                                      ref={youtubeThumbInputRef}
                                      type="file"
                                      accept="image/jpeg,image/png,image/webp"
                                      className="hidden"
                                      onChange={(event) => {
                                        const file = event.currentTarget.files?.[0];
                                        event.currentTarget.value = "";
                                        void prepareCoverImage(file, "youtube");
                                      }}
                                    />
                                    {primaryVideo && (
                                      <VideoCoverFramePicker
                                        video={primaryVideo}
                                        timestampMs={youtubeFrameMs}
                                        onChange={setYoutubeFrameMs}
                                        onSelectFrame={(video, timestampMs) =>
                                          void selectVideoFrame(video, timestampMs, "youtube")
                                        }
                                      />
                                    )}
                                    <label className="block max-w-sm">
                                      <span className="text-xs font-semibold text-muted-foreground">
                                        Visibility
                                      </span>
                                      <select
                                        value={youtubePrivacy}
                                        onChange={(event) => setYoutubePrivacy(event.target.value)}
                                        className={`mt-2 ${micro.input}`}
                                      >
                                        <option value="private">Private</option>
                                        <option value="unlisted">Unlisted</option>
                                        <option value="public">Public</option>
                                      </select>
                                    </label>
                                  </ProviderComposeCard>
                                )}

                                {instagramReelCover && (
                                  <ProviderComposeCard
                                    provider="instagram"
                                    title="Instagram"
                                    hint="Choose Trial Reel delivery and a custom thumbnail"
                                  >
                                    <label className="flex items-center gap-2 text-sm font-medium">
                                      <input
                                        type="checkbox"
                                        checked={instagramTrialReel}
                                        onChange={(event) =>
                                          setInstagramTrialReel(event.target.checked)
                                        }
                                      />
                                      Publish as a Trial Reel
                                    </label>
                                    {instagramTrialReel && (
                                      <label className="block max-w-sm">
                                        <span className="text-xs font-semibold text-muted-foreground">
                                          Graduation strategy
                                        </span>
                                        <select
                                          aria-label="Graduation strategy"
                                          value={instagramGraduationStrategy}
                                          onChange={(event) =>
                                            setInstagramGraduationStrategy(
                                              event.target
                                                .value as InstagramTrialGraduationStrategy,
                                            )
                                          }
                                          className={`mt-2 ${micro.input}`}
                                        >
                                          <option value="MANUAL">Manual</option>
                                          <option value="SS_PERFORMANCE">
                                            Automatic if it performs well
                                          </option>
                                        </select>
                                      </label>
                                    )}
                                    <CoverImagePicker
                                      label="Thumbnail"
                                      hint="Portrait JPEG works best. This image is sent as the Reel cover."
                                      aspect="portrait"
                                      image={instagramCoverMedia}
                                      uploading={uploading}
                                      onPick={() => instagramCoverInputRef.current?.click()}
                                      onRemove={() => replacePendingThumbnail("instagram", null)}
                                    />
                                    <input
                                      ref={instagramCoverInputRef}
                                      type="file"
                                      accept="image/jpeg,image/png,image/webp"
                                      className="hidden"
                                      onChange={(event) => {
                                        const file = event.currentTarget.files?.[0];
                                        event.currentTarget.value = "";
                                        void prepareCoverImage(file, "instagram");
                                      }}
                                    />
                                    {primaryVideo && (
                                      <VideoCoverFramePicker
                                        video={primaryVideo}
                                        timestampMs={instagramFrameMs}
                                        onChange={setInstagramFrameMs}
                                        onSelectFrame={(video, timestampMs) =>
                                          void selectVideoFrame(video, timestampMs, "instagram")
                                        }
                                      />
                                    )}
                                  </ProviderComposeCard>
                                )}

                                {connectedProviders.includes("tiktok") && (
                                  <ProviderComposeCard
                                    provider="tiktok"
                                    title="TikTok"
                                    hint="TikTok does not accept a custom thumbnail image. Pick a frame from this video."
                                  >
                                    {tiktokCreatorInfo.isPending && (
                                      <p className="text-sm text-muted-foreground">
                                        Checking the latest TikTok posting options…
                                      </p>
                                    )}
                                    {tiktokCreatorInfo.isError && (
                                      <p className="text-sm text-rose-600">
                                        {tiktokCreatorInfo.error instanceof Error
                                          ? tiktokCreatorInfo.error.message
                                          : "Reconnect TikTok before posting."}
                                      </p>
                                    )}
                                    {tiktokCreatorInfo.data?.length ? (
                                      <p className="text-sm font-medium">
                                        Posting to{" "}
                                        {tiktokCreatorInfo.data
                                          .map((creator) => creator.nickname)
                                          .join(", ")}
                                      </p>
                                    ) : null}
                                    {tiktokCreatorInfo.isSuccess &&
                                      tiktokPrivacyOptions.length === 0 && (
                                        <p className="text-sm text-rose-600">
                                          The selected TikTok accounts have no common privacy
                                          option. Post to them separately.
                                        </p>
                                      )}
                                    {primaryVideo && (
                                      <VideoCoverFramePicker
                                        video={primaryVideo}
                                        timestampMs={tiktokCoverMs}
                                        onChange={setTiktokCoverMs}
                                      />
                                    )}
                                    <label className="block max-w-sm">
                                      <span className="text-xs font-semibold text-muted-foreground">
                                        Privacy
                                      </span>
                                      <select
                                        value={tiktokPrivacy}
                                        onChange={(event) => setTiktokPrivacy(event.target.value)}
                                        className={`mt-2 ${micro.input}`}
                                        disabled={!tiktokCreatorInfo.isSuccess}
                                      >
                                        <option value="">Choose privacy</option>
                                        {tiktokPrivacyOptions.map((option: string) => (
                                          <option key={option} value={option}>
                                            {TIKTOK_PRIVACY_LABELS[option] || option}
                                          </option>
                                        ))}
                                      </select>
                                      <span className="mt-2 block text-xs text-muted-foreground">
                                        Options come from TikTok for the selected account. Sandbox
                                        posts use Only me.
                                      </span>
                                    </label>
                                    <fieldset className="space-y-2">
                                      <legend className="text-xs font-semibold text-muted-foreground">
                                        Allow interactions
                                      </legend>
                                      <label className="flex items-center gap-2 text-sm">
                                        <input
                                          type="checkbox"
                                          checked={tiktokAllowComment}
                                          disabled={tiktokInteractionDisabled.comment}
                                          onChange={(event) =>
                                            setTiktokAllowComment(event.target.checked)
                                          }
                                        />
                                        Comments
                                        {tiktokInteractionDisabled.comment
                                          ? " (disabled in TikTok)"
                                          : ""}
                                      </label>
                                      <label className="flex items-center gap-2 text-sm">
                                        <input
                                          type="checkbox"
                                          checked={tiktokAllowDuet}
                                          disabled={tiktokInteractionDisabled.duet}
                                          onChange={(event) =>
                                            setTiktokAllowDuet(event.target.checked)
                                          }
                                        />
                                        Duet
                                        {tiktokInteractionDisabled.duet
                                          ? " (disabled in TikTok)"
                                          : ""}
                                      </label>
                                      <label className="flex items-center gap-2 text-sm">
                                        <input
                                          type="checkbox"
                                          checked={tiktokAllowStitch}
                                          disabled={tiktokInteractionDisabled.stitch}
                                          onChange={(event) =>
                                            setTiktokAllowStitch(event.target.checked)
                                          }
                                        />
                                        Stitch
                                        {tiktokInteractionDisabled.stitch
                                          ? " (disabled in TikTok)"
                                          : ""}
                                      </label>
                                    </fieldset>
                                    <div className="space-y-3">
                                      <label className="flex items-center gap-2 text-sm font-medium">
                                        <input
                                          type="checkbox"
                                          checked={tiktokAiGenerated}
                                          onChange={(event) =>
                                            setTiktokAiGenerated(event.target.checked)
                                          }
                                        />
                                        This video is AI-generated
                                      </label>
                                      <label className="flex items-center gap-2 text-sm font-medium">
                                        <input
                                          type="checkbox"
                                          checked={tiktokCommercial}
                                          onChange={(event) => {
                                            setTiktokCommercial(event.target.checked);
                                            if (!event.target.checked) {
                                              setTiktokOwnBrand(false);
                                              setTiktokBrandedContent(false);
                                            }
                                          }}
                                        />
                                        This post promotes a brand, product, or service
                                      </label>
                                      {tiktokCommercial && (
                                        <div className="ml-6 space-y-2">
                                          <label className="flex items-center gap-2 text-sm">
                                            <input
                                              type="checkbox"
                                              checked={tiktokOwnBrand}
                                              onChange={(event) =>
                                                setTiktokOwnBrand(event.target.checked)
                                              }
                                            />
                                            Your brand (promotional content)
                                          </label>
                                          <label className="flex items-center gap-2 text-sm">
                                            <input
                                              type="checkbox"
                                              checked={tiktokBrandedContent}
                                              disabled={tiktokPrivacy === "SELF_ONLY"}
                                              onChange={(event) =>
                                                setTiktokBrandedContent(event.target.checked)
                                              }
                                            />
                                            Branded content (paid partnership)
                                          </label>
                                          {tiktokPrivacy === "SELF_ONLY" && (
                                            <p className="text-xs text-muted-foreground">
                                              Paid partnerships cannot use Only me privacy.
                                            </p>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </ProviderComposeCard>
                                )}
                              </div>
                            )}

                          {!hasVideo && needsYouTubeTitle && (
                            <label className="mt-5 block max-w-sm">
                              <span className="text-xs font-semibold text-muted-foreground">
                                YouTube visibility
                              </span>
                              <select
                                value={youtubePrivacy}
                                onChange={(event) => setYoutubePrivacy(event.target.value)}
                                className={`mt-2 ${micro.input}`}
                              >
                                <option value="private">Private</option>
                                <option value="unlisted">Unlisted</option>
                                <option value="public">Public</option>
                              </select>
                            </label>
                          )}

                          {Object.entries(providerErrors).length > 0 && (
                            <div className="mt-5 rounded-2xl bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
                              {Object.values(providerErrors)[0]}
                            </div>
                          )}
                        </div>

                        <PlatformPostPreview
                          connections={selectedConnections}
                          activeConnection={previewConnection}
                          onSelect={setPreviewConnectionId}
                          body={
                            previewConnection?.provider === "youtube" && youtubeDescription.trim()
                              ? youtubeDescription
                              : body
                          }
                          title={title}
                          xPostKind={xPostKind}
                          media={media}
                          youtubeThumbnail={youtubeThumbnailMedia}
                          youtubeFormat={youtubeFormat}
                          instagramCover={instagramReelCover ? instagramCoverMedia : null}
                          tiktokPrivacy={tiktokPrivacy}
                          youtubePrivacy={youtubePrivacy}
                          redditCommunity={redditCommunity}
                          redditKind={redditKind}
                          redditUrl={redditUrl}
                          onAvatarError={repairAvatar}
                        />
                      </div>
                    </div>

                    <div className="shrink-0 border-t border-border/70 bg-white/70 px-5 py-4 backdrop-blur sm:px-7">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap sm:items-end">
                          <div className="min-w-0 sm:max-w-xs">
                            <button
                              type="button"
                              onClick={openMediaPicker}
                              disabled={uploading || xArticle}
                              className={`${micro.btnSoft} w-full sm:w-auto ${
                                mediaCompatibility.disabled ||
                                media.length >= mediaCompatibility.maxMedia
                                  ? "cursor-not-allowed opacity-50"
                                  : ""
                              }`}
                            >
                              {uploading ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <ImagePlus className="size-4" />
                              )}
                              {uploading ? "Uploading…" : "Add media"}
                            </button>
                            <input
                              ref={mediaInputRef}
                              type="file"
                              accept={mediaCompatibility.accept}
                              multiple={mediaCompatibility.maxMedia > 1}
                              className="hidden"
                              onChange={(event) => {
                                const files = Array.from(event.currentTarget.files || []);
                                event.currentTarget.value = "";
                                void uploadFiles(files);
                              }}
                            />
                            <span className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">
                              {mediaCompatibility.summary}
                            </span>
                            {uploadError && (
                              <p className="mt-2 rounded-xl bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-700 dark:text-rose-300">
                                {uploadError}
                              </p>
                            )}
                          </div>
                          <label className="min-w-0">
                            <span className={`mb-1 block ${micro.eyebrowMuted}`}>Publish at</span>
                            <input
                              type="datetime-local"
                              value={scheduledAt}
                              min={minimumScheduleInput(schedulerTimeZone)}
                              onChange={(event) => setScheduledAt(event.target.value)}
                              className={`min-w-0 ${micro.input} py-2.5`}
                            />
                          </label>
                        </div>
                        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                          {tiktokSelected && (
                            <p className="w-full text-right text-xs text-muted-foreground">
                              By posting, you agree to TikTok&apos;s{" "}
                              {tiktokBrandedContent && (
                                <>
                                  <a
                                    href="https://www.tiktok.com/legal/page/global/bc-policy/en"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline"
                                  >
                                    Branded Content Policy
                                  </a>{" "}
                                  and{" "}
                                </>
                              )}
                              <a
                                href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                Music Usage Confirmation
                              </a>
                              .
                            </p>
                          )}
                          <button
                            type="button"
                            disabled={!canSubmit}
                            onClick={() => save.mutate({ publishNow: false, asDraft: true })}
                            className="rounded-lg px-3 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent"
                          >
                            Save draft
                          </button>
                          <div className="flex overflow-hidden rounded-lg bg-[#ff922b] text-white shadow-sm">
                            <button
                              type="button"
                              disabled={!canSubmit}
                              onClick={() => save.mutate({ publishNow: false })}
                              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[#f58218] disabled:opacity-45"
                            >
                              <CalendarClock className="size-4" /> Schedule
                            </button>
                            <button
                              type="button"
                              disabled={!canSubmit}
                              onClick={scheduleAtNextSlot}
                              aria-label="Schedule at the next posting slot"
                              className="inline-flex items-center border-l border-black/20 px-3 py-2.5 transition-colors hover:bg-[#f58218] disabled:opacity-45"
                            >
                              <ChevronRight className="size-4" />
                            </button>
                          </div>
                          <button
                            type="button"
                            disabled={!canSubmit}
                            onClick={() => save.mutate({ publishNow: true })}
                            aria-busy={publishingNow}
                            className={`${micro.btnPrimary} min-w-0 px-4 ${
                              publishingNow
                                ? "scale-[0.98] animate-pulse shadow-[0_0_0_4px_rgba(49,87,127,.12)] motion-reduce:animate-none"
                                : ""
                            }`}
                          >
                            {publishingNow ? (
                              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                            ) : (
                              <Send className="size-4" />
                            )}
                            {publishingNow ? "Publishing…" : "Publish now"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              <AlertDialog open={discardPromptOpen} onOpenChange={setDiscardPromptOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Save this post?</AlertDialogTitle>
                    <AlertDialogDescription>
                      You have changes that have not been saved. Save them as a draft or discard
                      them before closing.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {!canSubmit && (
                    <p className="text-sm text-muted-foreground">
                      {selected.length
                        ? "Complete the required post fields before saving this draft."
                        : "Select an account before saving this draft."}
                    </p>
                  )}
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep editing</AlertDialogCancel>
                    <button
                      type="button"
                      disabled={!canSubmit || save.isPending}
                      onClick={() => save.mutate({ publishNow: false, asDraft: true })}
                      className={`${micro.btnSoft} disabled:cursor-not-allowed disabled:opacity-45`}
                    >
                      Save draft
                    </button>
                    <AlertDialogAction
                      onClick={closeCompose}
                      className="bg-rose-600 text-white hover:bg-rose-700"
                    >
                      Discard
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <PostingTimesDialog
                open={postingSettingsOpen}
                schedule={data?.postingSchedule}
                saving={saveSchedule.isPending}
                onOpenChange={setPostingSettingsOpen}
                onSave={(schedule) => saveSchedule.mutate(schedule)}
              />
            </div>
          )}
        </MicroAppTabMotion>
      </div>
    </main>
  );
}

function PlatformPostPreview({
  connections,
  activeConnection,
  onSelect,
  body,
  title,
  xPostKind,
  media,
  youtubeThumbnail,
  youtubeFormat,
  instagramCover,
  tiktokPrivacy,
  youtubePrivacy,
  redditCommunity,
  redditKind,
  redditUrl,
  onAvatarError,
}: {
  connections: SchedulerConnection[];
  activeConnection: SchedulerConnection | null;
  onSelect: (connectionId: string) => void;
  body: string;
  title: string;
  xPostKind: "post" | "article";
  media: SchedulerMedia[];
  youtubeThumbnail: SchedulerMedia | null;
  youtubeFormat: YouTubePostFormat | null;
  instagramCover: SchedulerMedia | null;
  tiktokPrivacy: string;
  youtubePrivacy: string;
  redditCommunity: string;
  redditKind: "self" | "link";
  redditUrl: string;
  onAvatarError?: (connectionId: string) => void;
}) {
  return (
    <section
      data-testid="scheduler-preview-pane"
      className="min-w-0 overflow-hidden border-t border-border/70 pt-6 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:border-l lg:border-t-0 lg:py-0 lg:pl-8"
      aria-label="Live preview"
    >
      {connections.length > 0 && (
        <div
          className="flex min-h-10 max-w-full items-center gap-1.5 overflow-x-auto pb-1"
          aria-label="Preview account"
        >
          {connections.map((connection) => {
            const Icon = PROVIDER_ICONS[connection.provider];
            const active = connection.id === activeConnection?.id;
            return (
              <button
                key={connection.id}
                type="button"
                onClick={() => onSelect(connection.id)}
                title={`${SOCIAL_PROVIDER_DEFINITIONS[connection.provider].name}: ${connection.displayName}`}
                aria-pressed={active}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold ${
                  active ? "bg-foreground text-background" : "bg-accent text-muted-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                {SOCIAL_PROVIDER_DEFINITIONS[connection.provider].name}
              </button>
            );
          })}
        </div>
      )}

      <FittedPreview>
        <div className={`${micro.soft} mt-2 p-3 sm:p-5`}>
          {activeConnection?.provider === "twitter" && xPostKind === "article" ? (
            <div className="rounded-2xl border border-border bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                X Article preview
              </p>
              <h3 className="mt-4 font-ui-display text-2xl">{title || "Article title"}</h3>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground/80">
                {body || "Your Article text will appear here."}
              </p>
            </div>
          ) : activeConnection ? (
            <ProviderPostPreview
              connection={activeConnection}
              body={body}
              title={title}
              media={media}
              youtubeThumbnail={youtubeThumbnail}
              youtubeFormat={youtubeFormat}
              instagramCover={instagramCover}
              tiktokPrivacy={tiktokPrivacy}
              youtubePrivacy={youtubePrivacy}
              redditCommunity={redditCommunity}
              redditKind={redditKind}
              redditUrl={redditUrl}
              onAvatarError={() => onAvatarError?.(activeConnection.id)}
            />
          ) : (
            <div
              className={`${micro.empty} flex min-h-48 items-center justify-center px-6 text-sm text-muted-foreground`}
            >
              Select a connected account above to see its platform preview.
            </div>
          )}
        </div>
      </FittedPreview>
    </section>
  );
}

function FittedPreview({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState({ scale: 1, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const renderedHeight = content.scrollHeight;
      const scale = fitPreviewScale(container.clientHeight, renderedHeight);
      setMeasurement({ scale, height: renderedHeight * scale });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden">
      <div style={measurement.height ? { height: measurement.height } : undefined}>
        <div
          ref={contentRef}
          className="w-full origin-top"
          style={{ transform: `scale(${measurement.scale})` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function postingSlotLabel(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(2000, 0, 1, hour, minute),
  );
}

export function SchedulerStatusLine({
  connections,
  posts,
  onAvatarError,
}: {
  connections: SchedulerConnection[];
  posts: SchedulerPost[];
  onAvatarError?: (connectionId: string) => void;
}) {
  useEffect(() => {
    for (const connection of connections) {
      if (connection.avatarUrl) continue;
      onAvatarError?.(connection.id);
    }
  }, [connections, onAvatarError]);
  const scheduled = posts.filter((post) => post.status === "scheduled").length;
  const publishing = posts.filter((post) => post.status === "publishing").length;
  const published = posts.filter((post) => post.status === "published").length;
  return (
    <div className="grid min-h-9 w-full grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-2 rounded-xl bg-[#e8f2ff] px-3 py-2.5 text-[11px] font-semibold text-[#31577f] min-[360px]:px-4 sm:flex sm:w-auto sm:flex-nowrap sm:gap-2.5 sm:px-2.5 sm:py-0">
      <div className="col-span-5 col-start-1 row-start-1 flex min-w-0 items-center justify-self-start gap-1.5 pl-1">
        <div className="flex -space-x-1.5" aria-label={`${connections.length} connected accounts`}>
          {connections.slice(0, 4).map((connection) => {
            const platform = SOCIAL_PROVIDER_DEFINITIONS[connection.provider].name;
            const username = connection.handle.trim() || connection.displayName;
            return (
              <span
                key={connection.id}
                tabIndex={0}
                aria-label={`${platform}, ${username}`}
                data-hover-guide={`${platform} · ${username}`}
                className="group/avatar relative z-0 block size-5 shrink-0 outline-none hover:z-20 focus-visible:z-20 sm:size-6"
              >
                <PreviewAvatar
                  connection={connection}
                  onError={() => onAvatarError?.(connection.id)}
                  className="!size-5 border-2 border-[#e8f2ff] transition-transform duration-150 ease-out group-hover/avatar:scale-125 group-focus-visible/avatar:scale-125 motion-reduce:transition-none sm:!size-6"
                />
              </span>
            );
          })}
        </div>
        <span className="h-4 w-px shrink-0 bg-[#6e9ac6]/35" aria-hidden="true" />
        <span className="whitespace-nowrap tabular-nums">{connections.length} connected</span>
      </div>
      <span className="hidden h-3 w-px bg-[#6e9ac6]/35 sm:block" aria-hidden="true" />
      <span className="col-start-1 row-start-2 justify-self-center whitespace-nowrap tabular-nums">
        {scheduled} scheduled
      </span>
      <span
        className="col-start-2 row-start-2 h-full w-px bg-[#6e9ac6]/35 sm:h-3"
        aria-hidden="true"
      />
      <span className="col-start-3 row-start-2 justify-self-center whitespace-nowrap tabular-nums">
        {publishing} publishing
      </span>
      <span
        className="col-start-4 row-start-2 h-full w-px bg-[#6e9ac6]/35 sm:h-3"
        aria-hidden="true"
      />
      <span className="col-start-5 row-start-2 justify-self-center whitespace-nowrap tabular-nums">
        {published} published
      </span>
    </div>
  );
}

function SchedulerCalendarView({
  posts,
  connections,
  postingSchedule,
  canCreate = false,
  canReschedule = false,
  onCreateForDate,
  onEditPost,
  onDuplicatePost,
  onDeletePost,
  onOpenPostingSettings,
  onReschedule,
  onAvatarError,
}: {
  posts: SchedulerPost[];
  connections: SchedulerConnection[];
  postingSchedule?: PostingSchedule;
  canCreate?: boolean;
  canReschedule?: boolean;
  onCreateForDate?: (date: Date, slotTime?: string) => void;
  onEditPost: (post: SchedulerPost) => void;
  onDuplicatePost: (post: SchedulerPost) => void;
  onDeletePost: (post: SchedulerPost) => void;
  onOpenPostingSettings: () => void;
  onReschedule: (postId: string, scheduledAt: string) => void;
  onAvatarError?: (connectionId: string) => void;
}) {
  const [view, setView] = useState<"month" | "week">("week");
  const [cursor, setCursor] = useState(() => new Date());
  const dates = socialCalendarDates(cursor, view);
  const postsByDate = new Map<string, SchedulerPost[]>();

  for (const post of posts) {
    if (!isSocialCalendarPost(post)) continue;
    const key = socialCalendarDateKey(post.scheduledAt);
    postsByDate.set(key, [...(postsByDate.get(key) || []), post]);
  }
  for (const dayPosts of postsByDate.values()) {
    dayPosts.sort(
      (left, right) =>
        new Date(left.scheduledAt || left.createdAt).getTime() -
        new Date(right.scheduledAt || right.createdAt).getTime(),
    );
  }

  const move = (amount: number) =>
    setCursor((current) => {
      const next = new Date(current);
      if (view === "month") next.setMonth(next.getMonth() + amount, 1);
      else next.setDate(next.getDate() + amount * 7);
      return next;
    });
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canReschedule) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const handleDrop = (event: DragEvent<HTMLElement>, date: Date, slotTime?: string) => {
    event.preventDefault();
    if (!canReschedule) return;
    if (!isSchedulableCalendarDay(date)) {
      toast.error("Pick today or a future day to reschedule.");
      return;
    }
    const postId =
      event.dataTransfer.getData(CALENDAR_POST_DRAG_MIME) ||
      event.dataTransfer.getData("text/plain");
    const post = posts.find((item) => item.id === postId);
    if (!post || !RESCHEDULABLE_POST_STATUSES.has(post.status)) return;
    const nextScheduledAt = scheduledAtForDroppedPost(
      post,
      date,
      postingSchedule?.timezone || browserTimeZone(),
      slotTime,
    );
    if (!nextScheduledAt) {
      toast.error("Choose a valid posting time.");
      return;
    }
    if (new Date(nextScheduledAt).getTime() < Date.now() + 60_000) {
      toast.error("That posting slot has already passed.");
      return;
    }
    onReschedule(post.id, nextScheduledAt);
  };
  const firstDate = dates[0];
  const lastDate = dates.at(-1)!;
  const heading =
    view === "month"
      ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(cursor)
      : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(firstDate)} – ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(lastDate)}`;
  const todayKey = socialCalendarDateKey(new Date());

  return (
    <MicroAppPanel className="overflow-hidden">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className={micro.eyebrowMuted}>Publishing calendar</p>
          <h2 className="mt-1 font-ui-display text-3xl">{heading}</h2>
        </div>
        <div className="flex w-full flex-col gap-3 xl:w-auto xl:flex-row xl:items-center">
          <SchedulerStatusLine
            connections={connections}
            posts={posts}
            onAvatarError={onAvatarError}
          />
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <div
              className="grid h-11 w-full grid-cols-2 items-center rounded-[10px] border border-black/[0.06] bg-[#f2f5fb] p-1 sm:w-auto"
              aria-label="Calendar view"
            >
              {(["week", "month"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  data-micro-app-tab
                  onClick={() => setView(option)}
                  className={`inline-flex h-8 items-center justify-center self-center rounded-md px-4 text-xs font-semibold capitalize ${
                    view === option
                      ? "bg-background text-[#17213a] shadow-sm"
                      : "text-muted-foreground"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="grid w-full grid-cols-[2.5rem_minmax(0,1fr)_2.5rem_2.5rem] gap-2 sm:flex sm:w-auto sm:items-center">
              <button
                type="button"
                onClick={() => move(-1)}
                aria-label={`Previous ${view}`}
                className={`${micro.btnSoft} size-10 rounded-lg px-0 py-0`}
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setCursor(new Date())}
                className={`${micro.btnSoft} h-10 w-full rounded-lg px-3 text-xs sm:w-auto`}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => move(1)}
                aria-label={`Next ${view}`}
                className={`${micro.btnSoft} size-10 rounded-lg px-0 py-0`}
              >
                <ChevronRight className="size-4" />
              </button>
              <button
                type="button"
                onClick={onOpenPostingSettings}
                aria-label="Posting time settings"
                title="Posting times"
                className={`${micro.btnSoft} size-10 rounded-lg px-0 py-0 text-[#17213a]`}
              >
                <Settings className="size-5" strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-[22px] border border-border/70 sm:overflow-x-auto">
        <div
          className="min-w-0 sm:min-w-[760px]"
          role="grid"
          aria-label={`${view} publishing calendar`}
        >
          <div
            className="hidden grid-cols-7 border-b border-border/70 bg-[#f2f5fb] sm:grid"
            role="row"
          >
            {dates.slice(0, 7).map((date) => (
              <div
                key={socialCalendarDateKey(date)}
                role="columnheader"
                className="px-3 py-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
              >
                {new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-7">
            {dates.map((date, index) => {
              const key = socialCalendarDateKey(date);
              const dayPosts = postsByDate.get(key) || [];
              const outsideMonth = view === "month" && date.getMonth() !== cursor.getMonth();
              const canCreateOnDay =
                canCreate && Boolean(onCreateForDate) && isSchedulableCalendarDay(date);
              const daySlots = (postingSchedule?.slots || [])
                .filter((slot) => slot.day === date.getDay())
                .sort((left, right) => left.time.localeCompare(right.time));
              const visibleSlots = daySlots.slice(0, view === "month" ? 2 : 4);
              const calendarTimeZone = postingSchedule?.timezone || browserTimeZone();
              const slotTimes = new Set(daySlots.map((slot) => slot.time));
              const postsBySlot = new Map<string, SchedulerPost[]>();
              const slottedPostIds = new Set<string>();
              for (const post of dayPosts) {
                if (!post.scheduledAt) continue;
                const time = isoToZonedDateTimeInput(post.scheduledAt, calendarTimeZone).slice(
                  11,
                  16,
                );
                if (!slotTimes.has(time)) continue;
                postsBySlot.set(time, [...(postsBySlot.get(time) || []), post]);
                slottedPostIds.add(post.id);
              }
              const unslottedPosts = dayPosts.filter((post) => !slottedPostIds.has(post.id));
              const visibleUnslottedPosts = unslottedPosts.slice(0, view === "month" ? 3 : 8);
              return (
                <div
                  key={key}
                  role="gridcell"
                  onDragOver={handleDragOver}
                  onDrop={(event) => handleDrop(event, date)}
                  className={`min-h-36 border-border/70 p-2 ${index ? "border-t sm:border-t-0" : ""} ${
                    index % 7 ? "sm:border-l" : ""
                  } ${
                    index >= 7 ? "sm:border-t" : ""
                  } ${outsideMonth ? "bg-accent/20 text-muted-foreground" : "bg-background/55"}`}
                >
                  <div className="mb-2 flex items-center justify-between gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:hidden">
                        {new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)}
                      </span>
                      <div
                        className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
                          key === todayKey ? "bg-primary text-primary-foreground" : ""
                        }`}
                      >
                        {date.getDate()}
                      </div>
                    </div>
                    {canCreateOnDay && (
                      <button
                        type="button"
                        onClick={() => onCreateForDate?.(date)}
                        aria-label={`Create post on ${new Intl.DateTimeFormat(undefined, {
                          weekday: "long",
                          month: "long",
                          day: "numeric",
                        }).format(date)}`}
                        className="inline-flex size-7 items-center justify-center rounded-full border border-border/80 bg-background/90 text-muted-foreground transition hover:border-primary/40 hover:bg-primary hover:text-primary-foreground"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    )}
                  </div>
                  {visibleSlots.length > 0 && (
                    <div className="mb-2 space-y-2">
                      {visibleSlots.map((slot) => {
                        const slotPosts = postsBySlot.get(slot.time) || [];
                        const visibleSlotPosts = slotPosts.slice(0, view === "month" ? 2 : 6);
                        return (
                          <div
                            key={slot.time}
                            onDragOver={(event) => {
                              event.stopPropagation();
                              handleDragOver(event);
                            }}
                            onDrop={(event) => {
                              event.stopPropagation();
                              handleDrop(event, date, slot.time);
                            }}
                            className="w-full rounded-[10px] border border-dashed border-[#31577f]/30 bg-[#e8f2ff]/65 p-1.5 transition-[border-color,background-color] duration-150 hover:border-[#31577f]/50 hover:bg-[#e8f2ff]"
                          >
                            <button
                              type="button"
                              onClick={() => canCreateOnDay && onCreateForDate?.(date, slot.time)}
                              className="flex min-h-8 w-full items-center justify-center gap-1.5 rounded-[7px] text-center text-[11px] font-semibold tabular-nums text-[#31577f] hover:bg-white/55"
                            >
                              <Clock3 className="size-3" />
                              {postingSlotLabel(slot.time)}
                            </button>
                            <div className="space-y-1.5">
                              {visibleSlotPosts.map((post) => (
                                <CalendarPost
                                  key={post.id}
                                  post={post}
                                  timeZone={calendarTimeZone}
                                  canReschedule={canReschedule}
                                  onEdit={() => onEditPost(post)}
                                  onDuplicate={() => onDuplicatePost(post)}
                                  onDelete={() => onDeletePost(post)}
                                />
                              ))}
                              {slotPosts.length > visibleSlotPosts.length && (
                                <p className="px-1 text-center text-[9px] font-semibold text-[#31577f]/70">
                                  +{slotPosts.length - visibleSlotPosts.length} more
                                </p>
                              )}
                              <button
                                type="button"
                                onClick={() => canCreateOnDay && onCreateForDate?.(date, slot.time)}
                                className="flex min-h-8 w-full items-center justify-center rounded-[7px] border border-dashed border-[#31577f]/20 bg-white/25 px-2 text-[9px] font-semibold text-[#31577f]/65 transition-[border-color,background-color,color] duration-150 hover:border-[#31577f]/40 hover:bg-white/60 hover:text-[#31577f]"
                              >
                                {slotPosts.length ? "Drop another post" : "Drop post here"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      {daySlots.length > visibleSlots.length && (
                        <p className="px-1 text-center text-[9px] font-semibold text-muted-foreground">
                          +{daySlots.length - visibleSlots.length} more slots
                        </p>
                      )}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {visibleUnslottedPosts.map((post) => (
                      <CalendarPost
                        key={post.id}
                        post={post}
                        timeZone={calendarTimeZone}
                        canReschedule={canReschedule}
                        onEdit={() => onEditPost(post)}
                        onDuplicate={() => onDuplicatePost(post)}
                        onDelete={() => onDeletePost(post)}
                      />
                    ))}
                    {unslottedPosts.length > visibleUnslottedPosts.length && (
                      <p className="px-1 text-[10px] font-semibold text-muted-foreground">
                        +{unslottedPosts.length - visibleUnslottedPosts.length} more
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {!posts.length && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {canCreate
            ? "Tap + on any day to create and schedule a post."
            : "Scheduled and published posts will appear on this calendar."}
        </p>
      )}
    </MicroAppPanel>
  );
}

function CalendarPost({
  post,
  timeZone,
  canReschedule = false,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  post: SchedulerPost;
  timeZone: string;
  canReschedule?: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const date = new Date(post.scheduledAt || post.createdAt);
  const draggable = canReschedule && RESCHEDULABLE_POST_STATUSES.has(post.status);
  const editable = RESCHEDULABLE_POST_STATUSES.has(post.status);
  const deletable = post.status === "scheduled" || post.status === "failed";
  const statusColor: Record<SchedulerPost["status"], string> = {
    draft: "bg-zinc-400",
    scheduled: "bg-sky-500",
    publishing: "bg-amber-500",
    published: "bg-emerald-500",
    partially_failed: "bg-orange-500",
    failed: "bg-rose-500",
    cancelled: "bg-zinc-400",
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={
            editable ? "Click to edit · Right-click for more actions" : "Right-click for actions"
          }
          draggable={draggable}
          onClick={editable ? onEdit : undefined}
          onDragStart={(event) => {
            if (!draggable) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(CALENDAR_POST_DRAG_MIME, post.id);
            event.dataTransfer.setData("text/plain", post.id);
          }}
          className={`w-full rounded-xl border border-border/70 bg-card px-2 py-2 text-left shadow-sm transition-[border-color,box-shadow,transform] duration-150 hover:border-[#31577f]/30 hover:shadow-md active:scale-[0.98] ${
            draggable ? "cursor-grab active:cursor-grabbing" : ""
          }`}
        >
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
            <span
              className={`size-1.5 shrink-0 rounded-full ${statusColor[post.status]} ${
                post.status === "publishing" ? "animate-pulse motion-reduce:animate-none" : ""
              }`}
            />
            <Clock3 className="size-2.5" />
            <span>
              {new Intl.DateTimeFormat(undefined, {
                hour: "numeric",
                minute: "2-digit",
                timeZone,
              }).format(date)}
            </span>
            <span className="ml-auto flex -space-x-0.5">
              {post.targets.slice(0, 3).map((target) => {
                const Icon = PROVIDER_ICONS[target.provider];
                return <Icon key={target.id} className="size-2.5" />;
              })}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-[10px] font-medium leading-4">
            {post.title || post.body || "Media post"}
          </p>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44 rounded-xl border-black/[0.08] p-1.5 shadow-xl">
        {editable && (
          <ContextMenuItem onSelect={onEdit} className="gap-2 rounded-lg px-2.5 py-2">
            <Pencil className="size-3.5" /> Edit post
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onDuplicate} className="gap-2 rounded-lg px-2.5 py-2">
          <Repeat2 className="size-3.5" /> Duplicate
        </ContextMenuItem>
        {deletable && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={onDelete}
              className="gap-2 rounded-lg px-2.5 py-2 text-rose-600 focus:bg-rose-50 focus:text-rose-700"
            >
              <Trash2 className="size-3.5" /> Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function scheduledAtForDroppedPost(
  post: SchedulerPost,
  date: Date,
  timeZone: string,
  slotTime?: string,
) {
  const time =
    slotTime ||
    (post.scheduledAt
      ? isoToZonedDateTimeInput(post.scheduledAt, timeZone).slice(11, 16)
      : "12:00");
  return zonedDateTimeInputToIso(`${socialCalendarDateKey(date)}T${time}`, timeZone);
}

function ProviderComposeCard({
  provider,
  title,
  hint,
  children,
}: {
  provider: SocialProvider;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  const Icon = PROVIDER_ICONS[provider];
  return (
    <section className={`${micro.soft} p-4 sm:p-5`}>
      <div className="flex items-start gap-3">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-white shadow-sm"
          style={{ color: SOCIAL_PROVIDER_DEFINITIONS[provider].color }}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function CoverImagePicker({
  label,
  hint,
  aspect,
  image,
  uploading,
  onPick,
  onRemove,
}: {
  label: string;
  hint: string;
  aspect: "video" | "portrait";
  image: SchedulerMedia | null;
  uploading: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  return (
    <div>
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <div
        className={`relative mt-2 overflow-hidden ${micro.soft} ${
          aspect === "video" ? "aspect-video" : "mx-auto aspect-[9/16] max-w-[180px]"
        }`}
      >
        {image ? (
          <>
            <DecodedImage src={image.url} alt="" className="size-full object-cover" />
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()}`}
              onClick={onRemove}
              className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur"
            >
              <X className="size-4" />
            </button>
          </>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 border border-dashed border-[#3478f6]/30 bg-white px-4 text-center text-xs text-muted-foreground">
            <ImagePlus className="size-5 text-[#3478f6]" />
            Choose a video frame or camera roll image
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onPick}
        disabled={uploading}
        className={`${micro.btnSoft} mt-2 w-full disabled:opacity-50`}
      >
        {uploading ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <ImagePlus className="size-4" />
        )}
        {uploading ? "Preparing…" : "Add from camera roll"}
      </button>
      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{hint}</p>
    </div>
  );
}

function timelineFrameTimestamps(durationMs: number, count = 8) {
  if (durationMs <= 0 || count <= 1) return [];
  const maxMs = durationMs - 1;
  return Array.from({ length: count }, (_, index) => Math.round((maxMs * index) / (count - 1)));
}

// eslint-disable-next-line react-refresh/only-export-components -- browser-frame capture is tested with this route UI
export async function captureVideoFrame(video: HTMLVideoElement, timestampMs: number) {
  if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
    throw new Error("This video frame is not ready yet.");
  }
  const targetSeconds = Math.min(video.duration, Math.max(0, timestampMs / 1_000));
  if (Math.abs(video.currentTime - targetSeconds) > 0.05) {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("This video frame took too long to load."));
      }, 5_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("This video frame could not be loaded."));
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.currentTime = targetSeconds;
    });
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not capture the video frame.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("Could not create the thumbnail."))),
      "image/jpeg",
      0.9,
    ),
  );
  return new File([blob], `video-thumbnail-${Math.round(timestampMs)}.jpg`, {
    type: "image/jpeg",
  });
}

function TimelineVideoFrame({
  video,
  timestampMs,
}: {
  video: SchedulerMedia;
  timestampMs: number;
}) {
  return (
    <video
      src={video.url}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      className="pointer-events-none size-full object-cover"
      onLoadedMetadata={(event) => {
        event.currentTarget.currentTime = Math.min(
          event.currentTarget.duration,
          timestampMs / 1_000,
        );
      }}
    />
  );
}

export function VideoCoverFramePicker({
  video,
  timestampMs,
  onChange,
  onSelectFrame,
}: {
  video: SchedulerMedia;
  timestampMs: number;
  onChange: (ms: number) => void;
  onSelectFrame?: (video: HTMLVideoElement, timestampMs: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [durationMs, setDurationMs] = useState(0);

  function syncFrame(ms: number) {
    const el = ref.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    el.currentTime = Math.min(el.duration, Math.max(0, ms / 1_000));
  }

  useEffect(() => {
    setDurationMs(0);
  }, [video.url]);

  const maxMs = Math.max(0, durationMs - 1);
  const valueMs = durationMs ? clampTikTokCoverTimestampMs(timestampMs, durationMs) : 0;
  const frameTimestamps = timelineFrameTimestamps(durationMs);

  return (
    <div>
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Film className="size-3.5" />
        Thumbnail frame
      </span>
      <div className={`${micro.soft} mx-auto mt-2 aspect-[9/16] max-h-72 overflow-hidden bg-black`}>
        <video
          ref={ref}
          src={video.url}
          aria-label="Selected thumbnail frame"
          muted
          playsInline
          preload="metadata"
          className="size-full object-cover"
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration;
            if (!Number.isFinite(duration) || duration <= 0) return;
            const nextDurationMs = Math.floor(duration * 1_000);
            setDurationMs(nextDurationMs);
            const clamped = clampTikTokCoverTimestampMs(timestampMs, nextDurationMs);
            if (clamped !== timestampMs) onChange(clamped);
            syncFrame(clamped);
          }}
        />
      </div>
      {frameTimestamps.length > 0 && (
        <div className="mt-3 flex gap-1.5 overflow-x-auto rounded-xl bg-black p-1.5">
          {frameTimestamps.map((frameMs) => {
            const selected = Math.abs(frameMs - valueMs) <= Math.max(100, maxMs / 16);
            return (
              <button
                key={frameMs}
                type="button"
                aria-label={`Choose frame at ${(frameMs / 1_000).toFixed(1)} seconds`}
                aria-pressed={selected}
                onClick={() => {
                  onChange(frameMs);
                  syncFrame(frameMs);
                  if (ref.current) onSelectFrame?.(ref.current, frameMs);
                }}
                className={`aspect-[4/5] min-w-12 flex-1 overflow-hidden rounded-lg border-2 transition sm:min-w-14 ${
                  selected ? "border-[#3478f6]" : "border-transparent opacity-65 hover:opacity-100"
                }`}
              >
                <TimelineVideoFrame video={video} timestampMs={frameMs} />
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        Frame at {(valueMs / 1_000).toFixed(1)}s
      </p>
    </div>
  );
}

function AccountChip({
  connection,
  selected,
  onToggle,
}: {
  connection: SchedulerConnection;
  selected: boolean;
  onToggle: () => void;
}) {
  const Icon = PROVIDER_ICONS[connection.provider];
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!connection.canPublish}
      title={connection.publishBlockReason || undefined}
      className={`inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium ring-1 transition disabled:cursor-not-allowed disabled:opacity-55 ${selected ? "bg-[#17213a] text-white ring-[#17213a]" : "bg-white ring-black/[0.08] hover:bg-[#f2f5fb]"}`}
    >
      <Icon className="size-4" />
      <span className="max-w-36 truncate">{connection.displayName}</span>
      {!connection.canPublish && <RefreshCw className="size-3.5" />}
      {selected && <Check className="size-3.5" />}
    </button>
  );
}

function PostRow({
  post,
  canEdit = true,
  onCancel,
  onDuplicate,
  onDelete,
}: {
  post: SchedulerPost;
  canEdit?: boolean;
  onCancel: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const cancellable = ["draft", "scheduled", "failed", "partially_failed"].includes(post.status);
  const deletable = ["draft", "cancelled", "failed"].includes(post.status);
  const media = post.media[0];
  const liveTargets = post.targets.filter((target) => target.remotePostUrl);
  const providerNames = [...new Set(post.targets.map((target) => target.provider))]
    .map((provider) => SOCIAL_PROVIDER_DEFINITIONS[provider].name)
    .join(" · ");
  const publishedAt = post.targets
    .flatMap((target) => (target.publishedAt ? [target.publishedAt] : []))
    .sort()[0];
  const timestamp =
    post.status === "published" || post.status === "partially_failed"
      ? publishedAt || post.scheduledAt || post.createdAt
      : post.scheduledAt || post.createdAt;
  const { likes, comments } = schedulerPostEngagement(post.targets);
  const statusStyles: Record<SchedulerPost["status"], string> = {
    draft: "bg-zinc-400",
    scheduled: "bg-sky-500",
    publishing: "bg-amber-500",
    published: "bg-emerald-500",
    partially_failed: "bg-orange-500",
    failed: "bg-rose-500",
    cancelled: "bg-zinc-400",
  };
  return (
    <article className="rounded-[20px] border border-black/[0.06] bg-white p-4 shadow-[0_1px_2px_rgba(23,33,58,.04)] transition-shadow hover:shadow-[0_10px_30px_-20px_rgba(23,33,58,.35)] sm:p-5">
      <div className="flex items-start gap-3.5 sm:gap-4">
        {media ? (
          <div className="size-16 shrink-0 overflow-hidden rounded-2xl bg-[#eef2f8] ring-1 ring-black/[0.05] sm:size-[72px]">
            {media.mimeType.startsWith("video/") ? (
              <video src={media.url} muted className="size-full object-cover" />
            ) : (
              <DecodedImage
                src={media.url}
                alt=""
                loading="lazy"
                className="size-full object-cover"
              />
            )}
          </div>
        ) : (
          <div
            title="Text post"
            role="img"
            aria-label="Text post"
            className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-[#eef2f8] font-ui-display text-xl font-semibold tracking-tight text-[#31577f] ring-1 ring-[#31577f]/10 sm:size-[72px]"
          >
            Aa
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="flex -space-x-1">
              {post.targets.map((target) => {
                const Icon = PROVIDER_ICONS[target.provider];
                return (
                  <span
                    key={target.id}
                    className="flex size-6 items-center justify-center rounded-full border-2 border-white bg-[#eef2f8] text-[#17213a]"
                  >
                    <Icon className="size-3" />
                  </span>
                );
              })}
            </span>
            <span className="truncate">{providerNames || "Social post"}</span>
          </div>
          {post.title && <h3 className="mt-2 line-clamp-1 text-sm font-semibold">{post.title}</h3>}
          <p
            className={`${post.title ? "mt-0.5 text-muted-foreground" : "mt-2 font-medium"} line-clamp-2 text-sm leading-5`}
          >
            {post.body || (media ? "Media post" : "Untitled post")}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 capitalize">
              <span
                className={`size-1.5 rounded-full ${statusStyles[post.status]} ${post.status === "publishing" ? "animate-pulse motion-reduce:animate-none" : ""}`}
              />
              {post.status.replace("_", " ")}
            </span>
            <time dateTime={timestamp}>{POST_DATE_FORMATTER.format(new Date(timestamp))}</time>
            {likes !== null && (
              <span
                className="inline-flex items-center gap-1"
                title="Likes across destinations"
                aria-label={`${likes} likes`}
              >
                <ThumbsUp className="size-3.5" />
                {ENGAGEMENT_NUMBER_FORMATTER.format(likes)}
              </span>
            )}
            {comments !== null && (
              <span
                className="inline-flex items-center gap-1"
                title="Comments across destinations"
                aria-label={`${comments} comments`}
              >
                <MessageCircle className="size-3.5" />
                {ENGAGEMENT_NUMBER_FORMATTER.format(comments)}
              </span>
            )}
            {liveTargets.length > 0 && (
              <span className="ml-auto flex flex-wrap gap-1.5">
                {liveTargets.map((target) => {
                  const Icon = PROVIDER_ICONS[target.provider];
                  return (
                    <a
                      key={target.id}
                      href={target.remotePostUrl!}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-7 items-center gap-1.5 rounded-lg bg-[#17213a] px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-[#31577f]"
                    >
                      {liveTargets.length > 1 && <Icon className="size-3" />}
                      {liveTargets.length === 1
                        ? "View post"
                        : SOCIAL_PROVIDER_DEFINITIONS[target.provider].name}
                      <ExternalLink className="size-3" />
                    </a>
                  );
                })}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-0.5">
          {canEdit && post.status !== "published" && (
            <button
              type="button"
              onClick={onDuplicate}
              aria-label="Duplicate post"
              className="inline-flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Repeat2 className="size-3.5" />
            </button>
          )}
          {canEdit && cancellable && (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel post"
              className="inline-flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
          {deletable && (
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete post"
              className="inline-flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-600"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>
      {post.targets.some((target) => target.status === "failed" && target.errorMessage) && (
        <div className="mt-3 space-y-2">
          {post.targets
            .filter((target) => target.status === "failed" && target.errorMessage)
            .map((target) => (
              <p
                key={`${target.id}-error`}
                className="rounded-2xl bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-700 dark:text-rose-300"
              >
                {SOCIAL_PROVIDER_DEFINITIONS[target.provider].name}: {target.errorMessage}
              </p>
            ))}
        </div>
      )}
    </article>
  );
}
