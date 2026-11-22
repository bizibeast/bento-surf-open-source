import type { AgentAttachment } from "@/lib/content-agent-attachments";
import { FeaturebaseHub } from "@/components/FeaturebaseHub";
import { getAgentPreviewAccounts } from "@/lib/scheduler-assist.functions";
import type { AgentDraftEdit } from "@/lib/content-carousel";
import { ProactiveMessageFeedback } from "@/components/content/ProactiveMessageFeedback";
import { DiscoverPreferences } from "@/components/content/DiscoverPreferences";
import { STRATEGY_PLATFORMS, type StrategyPlatform } from "@/lib/content-brain";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { z } from "zod";
import "@/components/content/content-workspace.css";
import { ChatContentArtifact } from "@/components/content/ChatContentArtifact";
import { BennyModelPicker } from "@/components/content/BennyModelPicker";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { BennyInspector, type BennyPanel } from "@/components/content/BennyInspector";
import { BennyMemory } from "@/components/content/BennyMemory";
import { AppHeader } from "@/components/AppHeader";
import {
  ContentAgent,
  type ContentAgentMessage,
  type ContentAgentThread,
} from "@/components/content/ContentAgent";
import { ContentAgentSettings } from "@/components/content/ContentAgentSettings";
import { bennyModelSelection } from "@/lib/benny-models";
import { ContentReferences } from "@/components/content/ContentReferences";
import { getContentReferenceCapability } from "@/lib/content-reference.functions";
import { getBennyAiSettings } from "@/lib/benny-byok.functions";
import { bennyWebSearchQuerySchema } from "@/lib/benny-byok";
import {
  analyticsHandoffSchema,
  type AnalyticsHandoff,
  type DiscoverPostContextInput,
} from "@/lib/content-discover-post-context";
import { getAnalyticsPostHandoff } from "@/lib/content-analytics-handoff.functions";
import { getContentStudioAccess } from "@/lib/content-studio-access.functions";
import { createContentAgentWebMcpTools } from "@/lib/content-agent-webmcp";
import { useWebMcpTools } from "@/lib/webmcp";
import type {
  ContentAgentThreadPage,
  ContentAgentThreadCursor,
} from "@/lib/content-agent-identity.server";
import {
  getOrCreateNamedAgentThread,
  updateContentAgentPreferences,
  type ContentAgentPreferencesInput,
} from "@/lib/content-agent-preferences.functions";
import { ContentBrain, type ContentBrainSection } from "@/components/content/ContentBrain";
import { ContentDiscover } from "@/components/content/ContentDiscover";
import { DiscoverLoading } from "@/components/content/DiscoverLoading";
import { useDiscoverFeed } from "@/hooks/use-discover-feed";
import { usePageActivity } from "@/hooks/use-page-activity";
import { pagePollInterval } from "@/lib/page-poll";
import { discoverAgentSeed, type DiscoverBoostAction } from "@/components/content/discover-utils";
import { ContentRoutines, type ContentRoutineView } from "@/components/content/ContentRoutines";
import { MicroAppPanel } from "@/components/MicroAppPanel";
import {
  confirmBrainItem,
  deleteBrainItem,
  getContentBrain,
  getContentBrainMedia,
  recordContentBrainVisit,
  saveBrainItem,
  searchContentBrainMedia,
  saveContentProfile,
  setBrainItemLocked,
} from "@/lib/content-brain.functions";
import type { BrainItemInput, ContentProfile } from "@/lib/content-brain";
import {
  approveAgentBrainProposal,
  approveAgentScheduleProposal,
  generateInitialBrainSuggestions,
  getContentAgentThread,
  listContentAgentThreadsPage,
  setContentAgentThreadPinned,
  renameContentAgentChat,
  deleteContentAgentChat,
  markContentAgentThreadRead,
  regenerateAgentDraft,
  rejectAgentDraft,
  sendContentAgentMessage,
  saveAgentDraft,
  giveContentAgentFeedback,
} from "@/lib/content-agent.functions";
import {
  getDiscoverCreator,
  saveDiscoverItem,
  unsaveDiscoverItem,
  trackDiscoverCreator,
  untrackDiscoverCreator,
  setDiscoverFeedback,
  type DiscoverRecommendation,
} from "@/lib/content-discovery.functions";
import { micro } from "@/lib/micro-app-ui";
import {
  getContentRoutines,
  getContentRoutineActivity,
  type ContentRoutineInput,
  saveContentRoutine,
  setContentRoutinePaused,
} from "@/lib/content-routines.functions";
import { uploadFileResult } from "@/lib/upload";
import { optimizeImageUpload } from "@/lib/image-upload";
import {
  checkContentMediaUpload,
  registerContentMediaUpload,
  requestContentMediaFromPost,
  createContentMediaFolder,
  renameContentMediaFolder,
  deleteContentMediaFolder,
  moveContentMediaToFolder,
  setContentHeroImage,
  previewOldContentMedia,
} from "@/lib/content-media.functions";

type ContentTab = "discover" | "agent" | "brain" | "studio";
type StudioSeed = { format: "carousel" | "reel"; title: string; text: string; url: string | null };

const contentSearchSchema = z.object({
  tab: z.enum(["discover", "agent", "brain", "studio"]).optional().catch("discover"),
  section: z
    .enum([
      "profile",
      "instruction",
      "strategy",
      "topics",
      "story",
      "library",
      "file",
      "photo",
      "sources",
      "skill",
      "creative",
      "preferences",
    ])
    .optional(),
  item: z.string().uuid().optional(),
  project: z.string().uuid().optional(),
  reference: z.string().uuid().optional(),
  thread: z.string().uuid().optional(),
  analyticsPost: analyticsHandoffSchema.optional().catch(undefined),
  chat: z.literal("new").optional(),
  platform: z.enum(STRATEGY_PLATFORMS).optional(),
  routines: z
    .union([z.literal(true), z.literal("true")])
    .transform(() => true)
    .optional()
    .catch(false),
});

export const Route = createFileRoute("/_authenticated/content")({
  validateSearch: contentSearchSchema,
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: ({ context, deps }) =>
    deps.tab === "brain" || deps.tab === "agent"
      ? context.queryClient.prefetchQuery({
          queryKey: ["content-brain"],
          queryFn: () => getContentBrain(),
          staleTime: 5 * 60_000,
        })
      : undefined,
  head: () => ({ meta: [{ title: "Content | bento.surf" }] }),
  component: ContentRoutePage,
});

function ContentRoutePage() {
  const {
    tab = "discover",
    routines = false,
    section,
    item,
    project,
    reference,
    platform,
    thread: requestedThread,
    analyticsPost,
    chat,
  } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useWebMcpTools(
    createContentAgentWebMcpTools({
      refresh: () => queryClient.invalidateQueries(),
      openTab: (next) => navigate({ to: "/content", search: { tab: next } }),
    }),
  );
  return (
    <ContentPage
      initialThread={requestedThread}
      initialNewChat={chat === "new"}
      initialAnalyticsPost={analyticsPost}
      initialTab={tab}
      initialStudioEntry={project}
      initialReference={reference}
      initialRoutines={routines}
      initialBrainSection={section}
      initialBrainItem={item}
      initialBrainPlatform={platform}
      onBrainNavigate={(section, item, platform) =>
        void navigate({
          to: "/content",
          search: {
            tab: "brain",
            section,
            item: item || undefined,
            platform,
            thread: requestedThread,
            chat: chat === "new" ? "new" : undefined,
          },
        })
      }
      onThreadChange={(thread) =>
        void navigate({
          to: "/content",
          search: thread ? { tab: "agent", thread } : { tab: "agent", chat: "new" },
        })
      }
      onTabChange={(next) =>
        void navigate({
          to: "/content",
          search: { tab: next, thread: requestedThread, chat: chat === "new" ? "new" : undefined },
        })
      }
      onRoutinesChange={(open) =>
        void navigate({
          to: "/content",
          search: open
            ? {
                tab: "agent",
                routines: true,
                thread: requestedThread,
                chat: chat === "new" ? "new" : undefined,
              }
            : { tab: "agent", thread: requestedThread, chat: chat === "new" ? "new" : undefined },
        })
      }
    />
  );
}

export function ContentPage({
  initialThread,
  initialStudioEntry,
  initialReference,
  initialAnalyticsPost,
  initialNewChat = false,
  initialTab = "discover",
  initialRoutines = false,
  initialBrainSection,
  initialBrainItem,
  initialBrainPlatform,
  onBrainNavigate,
  onTabChange,
  onRoutinesChange,
  onThreadChange,
}: {
  initialThread?: string;
  initialStudioEntry?: string;
  initialReference?: string;
  initialNewChat?: boolean;
  initialTab?: ContentTab;
  initialRoutines?: boolean;
  initialAnalyticsPost?: AnalyticsHandoff;
  initialBrainSection?: ContentBrainSection;
  initialBrainItem?: string;
  initialBrainPlatform?: StrategyPlatform;
  onBrainNavigate?: (
    section: ContentBrainSection,
    item: string | null,
    platform: StrategyPlatform,
  ) => void;
  onTabChange?: (tab: ContentTab) => void;
  onRoutinesChange?: (open: boolean) => void;
  onThreadChange?: (threadId: string | null) => void;
}) {
  const [tab, setTab] = useState<ContentTab>(initialTab === "studio" ? "agent" : initialTab);
  const [brainSection, setBrainSection] = useState<ContentBrainSection | undefined>(
    initialBrainSection,
  );
  const [mediaSearch, setMediaSearch] = useState("");
  const [settledMediaSearch, setSettledMediaSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettledMediaSearch(mediaSearch), 300);
    return () => clearTimeout(timer);
  }, [mediaSearch]);
  const [agentSeed, setAgentSeed] = useState("");
  const [referencesDialog, setReferencesDialog] = useState({
    initialReference,
    open: Boolean(initialReference),
  });
  const showReferences =
    referencesDialog.initialReference === initialReference
      ? referencesDialog.open
      : Boolean(initialReference);
  const setShowReferences = (open: boolean) => setReferencesDialog({ initialReference, open });
  const [discoverPost, setDiscoverPost] = useState<DiscoverPostContextInput & { title: string }>();
  const [editingEntryId, setEditingEntryId] = useState<string | undefined>(initialStudioEntry);
  const analyticsSource = useQuery({
    queryKey: [
      "content-analytics-handoff",
      initialAnalyticsPost?.connectionId,
      initialAnalyticsPost?.remotePostId,
    ],
    enabled: Boolean(initialAnalyticsPost),
    retry: false,
    queryFn: () => {
      if (!initialAnalyticsPost) throw new Error("Choose an Analytics post.");
      const { connectionId, remotePostId } = initialAnalyticsPost;
      return getAnalyticsPostHandoff({ data: { connectionId, remotePostId } });
    },
  });
  const usedAnalyticsSource = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialAnalyticsPost || !analyticsSource.data) return;
    const { intent, connectionId, remotePostId } = initialAnalyticsPost;
    if (intent === "carousel" || intent === "reel") {
      setAgentSeed(
        `Create an original ${intent} based on this post: ${analyticsSource.data.summary}`,
      );
      setTab("agent");
      return;
    }
    const key = JSON.stringify([intent, connectionId, remotePostId]);
    if (usedAnalyticsSource.current === key) return;
    usedAnalyticsSource.current = key;
    const { title } = analyticsSource.data;
    setAgentSeed(discoverAgentSeed(intent));
    setDiscoverPost({ analyticsPost: { connectionId, remotePostId }, action: intent, title });
  }, [analyticsSource.data, initialAnalyticsPost]);
  useEffect(() => {
    if (analyticsSource.error) toast.error("This Analytics post could not be opened.");
  }, [analyticsSource.error]);
  const [webSearchOpen, setWebSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPayer, setSearchPayer] = useState<"own" | "managed">();
  const [activeThreadId, setActiveThreadId] = useState<string | null | undefined>(
    initialNewChat ? null : initialThread,
  );
  const [memoryView, setMemoryView] = useState<"knowledge" | "preferences">("knowledge");
  const memoryReturnFocus = useRef<HTMLElement | null>(null);
  const [aiOverride, setAiOverride] = useState<string>();
  useEffect(() => {
    setActiveThreadId(initialNewChat ? null : initialThread);
  }, [initialNewChat, initialThread]);
  const [showRoutines, setShowRoutines] = useState(initialRoutines);
  const bennySettings = useQuery({
    queryKey: ["benny-ai-settings"],
    queryFn: () => getBennyAiSettings(),
    enabled: tab !== "discover",
    staleTime: 5 * 60_000,
    retry: false,
  });
  const aiSettings = bennySettings.data;
  const byokOnly = Boolean(aiSettings && !aiSettings.managedAvailable);
  const modelSelection = bennyModelSelection(aiSettings, aiOverride);
  const selectedProvider = modelSelection.provider;
  const mayUseManagedSearch = Boolean(aiSettings?.managedSearch && !selectedProvider);
  const searchBilling = searchPayer ?? (mayUseManagedSearch ? "managed" : "own");
  const searchAvailable = Boolean(aiSettings?.searchConnected || mayUseManagedSearch);
  const searchValid =
    webSearchOpen &&
    bennyWebSearchQuerySchema.safeParse(searchQuery).success &&
    (searchBilling === "managed" ? mayUseManagedSearch : aiSettings?.searchConnected);
  const studioAccess = useQuery({
    queryKey: ["content-studio-access"],
    queryFn: () => getContentStudioAccess(),
    enabled: true,
    staleTime: 60_000,
    retry: false,
  });
  const referenceCapability = useQuery({
    queryKey: ["content-reference-capability"],
    queryFn: () => getContentReferenceCapability(),
    enabled: tab === "agent" || Boolean(initialReference),
    staleTime: 60_000,
    retry: false,
  });
  const referencesEnabled = referenceCapability.data === true;

  const queryClient = useQueryClient();
  const activity = usePageActivity();

  useEffect(() => {
    setTab(initialTab === "studio" ? "agent" : initialTab);
    setShowRoutines(initialRoutines);
  }, [initialRoutines, initialTab]);
  useEffect(() => setBrainSection(initialBrainSection), [initialBrainSection]);
  useEffect(() => {
    if (tab === "brain") void recordContentBrainVisit().catch(() => undefined);
  }, [tab]);
  const brain = useQuery({
    queryKey: ["content-brain"],
    queryFn: () => getContentBrain(),
    enabled: tab !== "discover",
    refetchInterval: (query) =>
      tab === "brain" && ["pending", "running"].includes(query.state.data?.indexing?.status || "")
        ? pagePollInterval(30_000, activity)
        : false,
    refetchIntervalInBackground: false,
  });
  const mediaOpen = tab === "brain" && (brainSection === "photo" || brainSection === "file");
  const media = useInfiniteQuery({
    queryKey: ["content-brain-media"],
    queryFn: ({ pageParam }) => getContentBrainMedia({ data: { page: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length : undefined),
    enabled: mediaOpen,
  });
  const searchedMedia = useQuery({
    queryKey: ["content-media-search", settledMediaSearch],
    queryFn: () => searchContentBrainMedia({ data: { query: settledMediaSearch } }),
    enabled: mediaOpen && settledMediaSearch.length > 1,
  });
  const {
    discover,
    refresh: researchDiscover,
    refreshing: discoverRefreshing,
    refreshStatus: discoverRefreshStatus,
    refreshError: discoverRefreshError,
    loadingStatus: discoverLoadingStatus,
    pagination: discoverPagination,
    loadMore: loadMoreDiscoverPosts,
    availablePlatforms: discoverPlatforms,
  } = useDiscoverFeed(tab === "discover");
  const previewAccounts = useQuery({
    queryKey: ["agent-preview-accounts"],
    queryFn: () => getAgentPreviewAccounts(),
    enabled: tab !== "discover" && !byokOnly,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const agentIdentity = useQuery({
    queryKey: ["content-agent-identity"],
    queryFn: () => getOrCreateNamedAgentThread(),
    enabled: tab !== "discover",
  });
  const threads = useInfiniteQuery({
    queryKey: ["content-agent-threads"],
    queryFn: ({ pageParam }) => listContentAgentThreadsPage({ data: { cursor: pageParam } }),
    initialPageParam: null as ContentAgentThreadCursor | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: tab !== "discover",
    refetchInterval: () => pagePollInterval(120_000, activity),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  // Undefined means the default named agent. Null is an intentional new ordinary chat.
  const resolvedThreadId =
    activeThreadId === undefined ? agentIdentity.data?.thread.id || null : activeThreadId;
  const thread = useQuery({
    queryKey: ["content-agent-thread", resolvedThreadId],
    queryFn: async () => {
      const previous = queryClient.getQueryData<Awaited<ReturnType<typeof getContentAgentThread>>>([
        "content-agent-thread",
        resolvedThreadId,
      ]);
      const result = await getContentAgentThread({
        data: {
          threadId: resolvedThreadId as string,
          knownRevision: previous?.thread.content_revision,
        },
      });
      return result.unchanged && previous ? { ...result, messages: previous.messages } : result;
    },
    enabled: tab !== "discover" && Boolean(resolvedThreadId),
    refetchInterval: () => pagePollInterval(60_000, activity),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const sidebarThreads = [
    ...new Map(
      [...(threads.data?.pages.flatMap((page) => [page.agent, ...page.chats]) || [])].map(
        (item) => [item.id, item],
      ),
    ).values(),
  ];
  if (
    !sidebarThreads.some((item) => item.id === agentIdentity.data?.thread.id) &&
    agentIdentity.data
  )
    sidebarThreads.unshift(agentIdentity.data.thread);
  const refreshThreads = () =>
    queryClient.invalidateQueries({ queryKey: ["content-agent-threads"] });
  const pinThread = useContentMutation(
    (value: { threadId: string; pinned: boolean }) => setContentAgentThreadPinned({ data: value }),
    refreshThreads,
  );
  const renameChat = useMutation({
    mutationFn: (value: { threadId: string; title: string }) =>
      renameContentAgentChat({ data: value }),
    onSuccess: async (saved) => {
      await Promise.all([
        refreshThreads(),
        queryClient.invalidateQueries({ queryKey: ["content-agent-thread", saved.id] }),
      ]);
    },
  });
  const deleteChat = useMutation({
    mutationFn: (threadId: string) => deleteContentAgentChat({ data: { threadId } }),
    onSuccess: async (saved) => {
      queryClient.removeQueries({ queryKey: ["content-agent-thread", saved.id] });
      if (resolvedThreadId === saved.id) {
        const agentId = agentIdentity.data?.thread.id;
        setActiveThreadId(agentId);
        onThreadChange?.(agentId || null);
      }
      await refreshThreads();
    },
  });
  const markRead = useMutation({
    mutationFn: (value: { threadId: string; throughMessageId: string }) =>
      markContentAgentThreadRead({ data: value }),
    onSuccess: (saved) => {
      queryClient.setQueryData<InfiniteData<ContentAgentThreadPage>>(
        ["content-agent-threads"],
        (current) =>
          current && {
            ...current,
            pages: current.pages.map((page) => ({
              ...page,
              agent: page.agent.id === saved.id ? saved : page.agent,
              chats: page.chats.map((item) => (item.id === saved.id ? saved : item)),
            })),
          },
      );
    },
  });
  const markThreadRead = markRead.mutate;
  const onMarkRead = useCallback(
    (threadId: string, throughMessageId: string) => {
      markThreadRead({ threadId, throughMessageId });
    },
    [markThreadRead],
  );
  const savePreferences = useMutation({
    mutationFn: (value: ContentAgentPreferencesInput) =>
      updateContentAgentPreferences({ data: value }),
    onSuccess: async (identity) => {
      queryClient.setQueryData(["content-agent-identity"], identity);
      await Promise.all([
        refreshThreads(),
        queryClient.invalidateQueries({ queryKey: ["content-agent-thread", identity.thread.id] }),
      ]);
    },
  });
  const routines = useQuery({
    queryKey: ["content-routines"],
    queryFn: () => getContentRoutines(),
    enabled: tab !== "discover",
  });

  const routineActivity = useQuery({
    queryKey: ["content-routine-activity"],
    queryFn: () => getContentRoutineActivity(),
    enabled: tab === "agent" && showRoutines,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["content-brain"] }),
      queryClient.invalidateQueries({ queryKey: ["content-brain-media"] }),
      queryClient.invalidateQueries({ queryKey: ["content-media-search"] }),
    ]);
  const profileMutation = useContentMutation(
    (value: ContentProfile) => saveContentProfile({ data: value }),
    refresh,
  );
  const itemMutation = useContentMutation(
    (value: BrainItemInput) => saveBrainItem({ data: value }),
    refresh,
  );
  const confirmMutation = useContentMutation(
    (id: string) => confirmBrainItem({ data: { id } }),
    refresh,
  );
  const lockMutation = useContentMutation(
    ({ id, locked }: { id: string; locked: boolean }) =>
      setBrainItemLocked({ data: { id, locked } }),
    refresh,
  );
  const deleteMutation = useContentMutation(
    (id: string) => deleteBrainItem({ data: { id } }),
    refresh,
  );
  const discoverRefresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["content-discover"] }),
      queryClient.invalidateQueries({ queryKey: ["content-brain"] }),
    ]);
  const resolveDiscoverCreator = useCallback(
    (item: DiscoverRecommendation) =>
      queryClient.fetchQuery({
        queryKey: ["discover-creator", item.sourceUrl || item.id],
        queryFn: () => getDiscoverCreator({ data: { id: item.id } }),
        staleTime: 5 * 60_000,
        retry: 1,
      }),
    [queryClient],
  );
  const saveRecommendation = useContentMutation(
    (id: string) => saveDiscoverItem({ data: { id } }),
    discoverRefresh,
  );
  const unsaveRecommendation = useContentMutation(
    (id: string) => unsaveDiscoverItem({ data: { id } }),
    discoverRefresh,
  );
  const likeRecommendation = useContentMutation(
    (id: string) => setDiscoverFeedback({ data: { id, feedback: "liked" } }),
    discoverRefresh,
  );
  const rejectRecommendation = useContentMutation(
    (id: string) => setDiscoverFeedback({ data: { id, feedback: "not_relevant" } }),
    discoverRefresh,
  );
  const clearRecommendationFeedback = useContentMutation(
    (id: string) => setDiscoverFeedback({ data: { id, feedback: "pending" } }),
    discoverRefresh,
  );
  const sendAgentMessage = useMutation({
    mutationFn: ({ text, attachments }: { text: string; attachments: AgentAttachment[] }) =>
      sendContentAgentMessage({
        data: {
          threadId: resolvedThreadId,
          text,
          attachmentIds: attachments.map((item) => item.id),
          ...(editingEntryId ? { editingEntryId } : {}),
          ...modelSelection.input,
          ...(discoverPost
            ? {
                discoverPost: {
                  ...("analyticsPost" in discoverPost
                    ? { analyticsPost: discoverPost.analyticsPost }
                    : { recommendationId: discoverPost.recommendationId }),
                  action: discoverPost.action,
                },
              }
            : {}),
          ...(searchValid
            ? { webSearch: { query: searchQuery.trim(), billing: searchBilling } }
            : {}),
        },
      }),
    onSuccess: async (result) => {
      setActiveThreadId(result.threadId);
      onThreadChange?.(result.threadId);
      setAgentSeed("");
      setDiscoverPost(undefined);
      setSearchQuery("");
      setWebSearchOpen(false);
      if (aiSettings?.managedUsage) void bennySettings.refetch();
      if (result.memoriesSaved) toast.success("Memory saved to About You.");
      if (result.memoryWarning) toast.error(result.memoryWarning);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: ["content-agent-threads"] }),
        queryClient.invalidateQueries({ queryKey: ["content-agent-thread", result.threadId] }),
      ]);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Agent could not finish this request."),
  });
  const buildBrain = useMutation({
    mutationFn: () => generateInitialBrainSuggestions(),
    onSuccess: async () => {
      await refresh();
      changeTab("brain");
      toast.success("Your connected posts are queued for automatic Brain and media indexing.");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Brain suggestions could not be created.",
      ),
  });
  const refreshAgent = () =>
    queryClient.invalidateQueries({ queryKey: ["content-agent-thread", resolvedThreadId] });
  const approveBrain = useContentMutation(
    ({ messageId, cardId }: { messageId: string; cardId: string }) =>
      approveAgentBrainProposal({ data: { messageId, cardId } }),
    () => Promise.all([refresh(), refreshAgent()]),
  );
  const rejectDraft = useContentMutation(
    (value: { messageId: string; cardId: string; reason: string }) =>
      rejectAgentDraft({ data: value }),
    refreshAgent,
  );
  const regenerateDraft = useMutation({
    mutationFn: (value: { messageId: string; cardId: string; reason: string }) =>
      regenerateAgentDraft({ data: value }),
    onSuccess: refreshAgent,
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Draft could not be regenerated."),
  });
  const saveDraft = useContentMutation(
    (value: { messageId: string; cardId: string } & AgentDraftEdit) =>
      saveAgentDraft({ data: value }),
    refreshAgent,
  );
  const approveSchedule = useContentMutation(
    (value: { messageId: string; draftCardId: string; scheduleCardId: string; revision: number }) =>
      approveAgentScheduleProposal({ data: value }),
    refreshAgent,
  );
  const refreshRoutines = () => queryClient.invalidateQueries({ queryKey: ["content-routines"] });
  const saveRoutine = useContentMutation(
    (value: ContentRoutineInput) => saveContentRoutine({ data: value }),
    refreshRoutines,
  );
  const pauseRoutine = useContentMutation(
    ({ id, paused }: { id: string; paused: boolean }) =>
      setContentRoutinePaused({ data: { id, paused } }),
    refreshRoutines,
  );

  const changeTab = (next: ContentTab) => {
    setTab(next === "studio" ? "agent" : next);
    setShowRoutines(false);

    onTabChange?.(next);
  };

  const openStudio = (source: StudioSeed) => {
    setAgentSeed(
      `Create an original ${source.format} in my style. ${source.title}\n${source.text}${source.url ? `\nReference: ${source.url}` : ""}`,
    );
    changeTab("agent");
  };

  const changeRoutines = (open: boolean) => {
    setShowRoutines(open);
    onRoutinesChange?.(open);
  };

  const openAgent = (item: DiscoverRecommendation, action: DiscoverBoostAction) => {
    setActiveThreadId(null);
    setAgentSeed(discoverAgentSeed(action));
    setDiscoverPost({ recommendationId: item.id, action, title: item.title });
    changeTab("agent");
    onThreadChange?.(null);
  };

  const upload = async (file: File, kind: "file" | "photo") => {
    try {
      if (kind === "photo" && !/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/.test(file.type))
        throw new Error("Use a JPG, PNG, WebP, GIF, MP4, or WebM file for images and videos.");
      const prepared =
        kind === "photo" && file.type.startsWith("image/")
          ? await optimizeImageUpload(file, "image")
          : file;
      if (kind === "photo")
        await checkContentMediaUpload({
          data: {
            bytes: prepared.size,
            kind: prepared.type.startsWith("video/") ? "video" : "image",
          },
        });
      const uploaded = await uploadFileResult(
        prepared,
        kind === "photo" ? (prepared.type.startsWith("video/") ? "video" : "image") : "file",
        { optimize: false },
      );
      if (!uploaded.publicUrl) throw new Error("Upload did not return a public URL.");
      if (kind === "photo") {
        await registerContentMediaUpload({ data: { key: uploaded.key, name: file.name } });
        await refresh();
        toast.success("Added to Files.");
        return;
      }
      await saveBrainItem({
        data: {
          kind,
          title: file.name,
          content: `${uploaded.mimeType} · ${uploaded.size.toLocaleString()} bytes`,
          provenance: "file",
          sourceUrl: uploaded.publicUrl,
          sourceRef: uploaded.key,
          status: "confirmed",
          locked: false,
        },
      });
      await refresh();
      toast.success("Added to your Brain.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    }
  };

  const data = brain.data;
  const mediaPhotos = [
    ...new Map(
      (media.data?.pages.flatMap((page) => page.photos) || []).map(
        (photo) => [photo.id, photo] as const,
      ),
    ).values(),
  ];
  const openPanel = (panel: BennyPanel) => {
    if (panel === "schedule") {
      if (tab !== "agent") changeTab("agent");
      changeRoutines(true);
      return;
    }
    memoryReturnFocus.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMemoryView("knowledge");
    changeTab("brain");
    setBrainSection("profile");
    onBrainNavigate?.("profile", null, initialBrainPlatform ?? "twitter");
  };
  const openMemoryPreferences = () => {
    changeRoutines(false);
    openPanel("memory");
    setMemoryView("preferences");
  };

  return (
    <main className={tab === "discover" ? "discover-shell" : "content-workspace agent-route"}>
      {tab === "discover" && <AppHeader title="Content" />}
      <div className={tab === "discover" ? "discover-shell-main" : "agent-route-body"}>
        <div className={tab !== "discover" ? "agent-route-body" : undefined}>
          {tab === "discover" && <DiscoverPreferences onSaved={() => researchDiscover(true)} />}
          {tab === "discover" &&
            (discover.isError && !discover.data ? (
              <EmptyWorkspace
                eyebrow="Discover"
                title="Discover could not load."
                description="We couldn't open your board. Your saved recommendations are safe."
                onRetry={() => void discover.refetch()}
              />
            ) : discover.data ? (
              <ContentDiscover
                data={discover.data}
                onResolveCreator={resolveDiscoverCreator}
                refreshing={discoverRefreshing}
                refreshStatus={discoverRefreshStatus}
                refreshError={discoverRefreshError}
                onRefresh={() => researchDiscover(true)}
                pagination={discoverPagination}
                onLoadMore={loadMoreDiscoverPosts}
                availablePlatforms={discoverPlatforms}
                onTrackCreator={async (input) => {
                  await trackDiscoverCreator({ data: input });
                  await discoverRefresh();
                  researchDiscover();
                }}
                onUntrackCreator={async (id) => {
                  await untrackDiscoverCreator({ data: { id } });
                  await discoverRefresh();
                }}
                onLike={async (id) => {
                  await likeRecommendation.mutateAsync(id);
                }}
                onClearFeedback={async (id) => {
                  await clearRecommendationFeedback.mutateAsync(id);
                }}
                onSave={async (id) => {
                  await saveRecommendation.mutateAsync(id);
                }}
                onUnsave={async (id) => {
                  await unsaveRecommendation.mutateAsync(id);
                }}
                onReject={async (id) => {
                  await rejectRecommendation.mutateAsync(id);
                }}
                onAskAgent={(item, action = "chat") => openAgent(item, action)}
                onCreateDraft={(item) => openAgent(item, "replicate")}
                onCreateStudio={typeof studioAccess.data === "string" ? openStudio : undefined}
              />
            ) : (
              <DiscoverLoading status={discoverLoadingStatus} />
            ))}
          <Dialog
            open={showRoutines}
            onOpenChange={(open) => {
              if (!open) changeRoutines(false);
            }}
          >
            <DialogContent className="content-workspace benny-editor-dialog">
              <DialogTitle className="pr-10 text-lg font-semibold">Schedule</DialogTitle>
              <DialogDescription className="sr-only">
                Manage Benny’s scheduled routines and review recent activity.
              </DialogDescription>
              <ContentRoutines
                embedded
                onSettings={openMemoryPreferences}
                routines={(routines.data || []) as ContentRoutineView[]}
                timezone={brain.data?.profile.timezone || "UTC"}
                activity={routineActivity.data || []}
                connectedProviders={(data?.sources || [])
                  .filter((source) => source.status === "active")
                  .map((source) => source.provider)}
                onSave={async (value) => {
                  await saveRoutine.mutateAsync(value);
                }}
                onPause={async (id, paused) => {
                  await pauseRoutine.mutateAsync({ id, paused });
                }}
                onClose={() => changeRoutines(false)}
              />
            </DialogContent>
          </Dialog>
          <Dialog open={referencesEnabled && showReferences} onOpenChange={setShowReferences}>
            <DialogContent className="max-w-3xl">
              <DialogTitle>Content references</DialogTitle>
              <DialogDescription>
                Study sources, inspect frames and create original drafts.
              </DialogDescription>
              {referencesEnabled && showReferences && (
                <ContentReferences
                  key={initialReference}
                  initialId={initialReference}
                  onUse={(prompt) => {
                    setAgentSeed(prompt);
                    setShowReferences(false);
                    changeTab("agent");
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
          {tab !== "discover" && (
            <ContentAgent
              headerActions={
                <>
                  {referencesEnabled && (
                    <button
                      type="button"
                      className="rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
                      data-reference-workspace-id={
                        typeof studioAccess.data === "string" ? studioAccess.data : undefined
                      }
                      onClick={() => setShowReferences(true)}
                    >
                      References
                    </button>
                  )}
                  <FeaturebaseHub inline />
                </>
              }
              inspector={
                <BennyInspector
                  memoryCount={data?.items.length ?? 0}
                  scheduleCount={
                    (routines.data ?? []).filter((entry: ContentRoutineView) => entry.enabled)
                      .length
                  }
                  onOpen={openPanel}
                />
              }
              workspaceId={typeof studioAccess.data === "string" ? studioAccess.data : undefined}
              onReviseContent={(id, title) => {
                setEditingEntryId(id);
                setAgentSeed(`Please revise “${title}”: `);
              }}
              conversationContent={
                initialStudioEntry && typeof studioAccess.data === "string" ? (
                  <ChatContentArtifact
                    workspaceId={studioAccess.data}
                    entryId={initialStudioEntry}
                    onRevise={(id, title) => {
                      setEditingEntryId(id);
                      setAgentSeed(`Please revise “${title}”: `);
                    }}
                  />
                ) : undefined
              }
              previewAccounts={previewAccounts.data || []}
              threads={sidebarThreads as ContentAgentThread[]}
              agentName={agentIdentity.data?.preferences.display_name || "Benny"}
              agentThreadId={agentIdentity.data?.thread.id || null}
              activeThreadTitle={thread.data?.thread?.title || undefined}
              onPinThread={(threadId, pinned) => pinThread.mutate({ threadId, pinned })}
              onRenameThread={(threadId, title) =>
                renameChat.mutateAsync({ threadId, title }).then(() => undefined)
              }
              onDeleteThread={(threadId) => deleteChat.mutateAsync(threadId).then(() => undefined)}
              onMarkRead={onMarkRead}
              readEnabled={tab === "agent" && !showRoutines}
              textOnly={byokOnly || Boolean(selectedProvider)}
              sendDisabled={
                Boolean(aiSettings && !modelSelection.valid) ||
                Boolean(aiOverride && !modelSelection.valid) ||
                (webSearchOpen && !searchValid)
              }
              draftTools={!byokOnly}
              modelControls={
                (aiSettings || discoverPost) && (
                  <div className="benny-composer-options flex flex-wrap items-center gap-2">
                    {discoverPost && (
                      <button
                        type="button"
                        title="Remove Discover source"
                        aria-label="Remove Discover source"
                        onClick={() => setDiscoverPost(undefined)}
                        className="max-w-full truncate rounded-md border border-border px-2 py-1 text-xs"
                      >
                        {discoverPost.title} ×
                      </button>
                    )}
                    {aiSettings && (
                      <>
                        <BennyModelPicker
                          value={modelSelection.valid ? modelSelection.choice : ""}
                          options={modelSelection.options}
                          onChange={setAiOverride}
                          disabled={sendAgentMessage.isPending}
                        />
                        {searchAvailable && (
                          <button
                            type="button"
                            aria-expanded={webSearchOpen}
                            onClick={() => setWebSearchOpen(!webSearchOpen)}
                            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                          >
                            Web search
                          </button>
                        )}
                        {webSearchOpen && (
                          <div className="flex w-full flex-wrap items-center gap-2">
                            <input
                              aria-label="Public web search query"
                              value={searchQuery}
                              maxLength={450}
                              onChange={(event) => setSearchQuery(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") event.preventDefault();
                              }}
                              placeholder="Public topic to search"
                              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
                            />
                            <select
                              aria-label="Web search billing"
                              value={searchBilling}
                              onChange={(event) =>
                                setSearchPayer(event.target.value as "own" | "managed")
                              }
                              className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                            >
                              <option value="own" disabled={!aiSettings.searchConnected}>
                                My Brave key
                              </option>
                              <option value="managed" disabled={!mayUseManagedSearch}>
                                Included allowance
                              </option>
                            </select>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              }
              identityUnavailable={
                activeThreadId !== undefined && agentIdentity.isError && !agentIdentity.data
              }
              onRetryIdentity={() => void agentIdentity.refetch()}
              pinningThreadId={pinThread.isPending ? pinThread.variables?.threadId : undefined}
              loadingThreads={threads.isPending}
              threadListError={
                threads.isError ? "Chats could not load. Your conversations are safe." : undefined
              }
              onRetryThreads={() => {
                if (threads.isFetchNextPageError) void threads.fetchNextPage();
                else void threads.refetch();
              }}
              hasMoreThreads={threads.hasNextPage}
              loadingMoreThreads={threads.isFetchingNextPage}
              onLoadMore={() => void threads.fetchNextPage()}
              loading={
                (activeThreadId === undefined && agentIdentity.isPending) ||
                (Boolean(resolvedThreadId) && thread.isPending)
              }
              loadError={
                activeThreadId === undefined && agentIdentity.isError && !agentIdentity.data
                  ? "Your agent could not load."
                  : thread.isError && !thread.data
                    ? "This conversation could not load."
                    : undefined
              }
              onRetry={() => {
                void agentIdentity.refetch();
                void threads.refetch();
                if (resolvedThreadId) void thread.refetch();
              }}
              activeThreadId={resolvedThreadId}
              messages={(thread.data?.messages || []) as ContentAgentMessage[]}
              renderMessageFooter={(message) => (
                <ProactiveMessageFeedback
                  payload={message.payload}
                  onFeedback={async (feedback) => {
                    await giveContentAgentFeedback({ data: { messageId: message.id, feedback } });
                    await refreshAgent();
                  }}
                />
              )}
              seed={agentSeed}
              brainEmpty={!byokOnly && !brain.data?.items.length}
              sending={sendAgentMessage.isPending}
              onNewThread={() => {
                setActiveThreadId(null);
                setAgentSeed("");
                setDiscoverPost(undefined);
                setEditingEntryId(undefined);
                setWebSearchOpen(false);
                setSearchQuery("");
                onThreadChange?.(null);
              }}
              onSelectThread={(id) => {
                setActiveThreadId(id);
                setAgentSeed("");
                setDiscoverPost(undefined);
                setEditingEntryId(undefined);
                setWebSearchOpen(false);
                setSearchQuery("");
                onThreadChange?.(id);
              }}
              onSend={async (text, attachments = []) => {
                await sendAgentMessage.mutateAsync({ text, attachments });
              }}
              onDraftChanged={refreshAgent}
              onStudioDraft={typeof studioAccess.data === "string" ? openStudio : undefined}
              onSaveDraft={async (messageId, cardId, edit) => {
                await saveDraft.mutateAsync({ messageId, cardId, ...edit });
              }}
              onBuildBrain={() => buildBrain.mutate()}
              onApproveBrain={(messageId, cardId) => approveBrain.mutate({ messageId, cardId })}
              onRejectDraft={(messageId, cardId, reason) =>
                rejectDraft.mutateAsync({ messageId, cardId, reason }).then(() => undefined)
              }
              onRegenerateDraft={(messageId, cardId, reason) =>
                regenerateDraft.mutateAsync({ messageId, cardId, reason }).then(() => undefined)
              }
              onApproveSchedule={(messageId, draftCardId, scheduleCardId, revision) =>
                approveSchedule
                  .mutateAsync({ messageId, draftCardId, scheduleCardId, revision })
                  .then(() => undefined)
              }
            />
          )}

          <Dialog
            open={tab === "brain"}
            onOpenChange={(open) => {
              if (!open) changeTab("agent");
            }}
          >
            <DialogContent
              className="content-workspace benny-editor-dialog"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const trigger = memoryReturnFocus.current;
                if (trigger?.isConnected) trigger.focus();
                else
                  document
                    .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Agent"]')
                    ?.focus();
              }}
            >
              <DialogTitle className="pr-10 text-lg font-semibold">Memory</DialogTitle>
              <DialogDescription className="sr-only">
                Manage the preferences and source material Benny uses in your content.
              </DialogDescription>
              {tab === "brain" &&
                (data ? (
                  <BennyMemory
                    initialView={memoryView}
                    preferencesPanel={
                      agentIdentity.data ? (
                        <ContentAgentSettings
                          embedded
                          preferences={agentIdentity.data.preferences}
                          onClose={() => changeTab("agent")}
                          onSave={(value) => savePreferences.mutateAsync(value)}
                        />
                      ) : (
                        <p role="status">Benny preferences are loading. Try reopening Memory.</p>
                      )
                    }
                    items={data.items}
                    onSave={async (value) => {
                      await itemMutation.mutateAsync(value);
                    }}
                    onOpenProjects={() => {
                      setAgentSeed("Show my saved designs and templates here.");
                      changeTab("agent");
                    }}
                    onOpenBranding={() => setBrainSection("preferences")}
                  >
                    {(panels, initialSection) => (
                      <ContentBrain
                        panels={panels}
                        initialSection={initialSection ?? brainSection}
                        initialItemId={initialBrainItem}
                        initialPlatform={initialBrainPlatform}
                        onNavigate={(section, item, platform) => {
                          setMemoryView("knowledge");
                          setBrainSection(section);
                          onBrainNavigate?.(section, item, platform);
                        }}
                        profile={data.profile}
                        humanSummary={data.humanSummary}
                        items={data.items}
                        sources={data.sources}
                        photos={
                          settledMediaSearch.length > 1 ? searchedMedia.data || [] : mediaPhotos
                        }
                        folders={media.data?.pages[0]?.folders || []}
                        mediaPending={media.data?.pages[0]?.mediaPending || 0}
                        manualMediaCount={media.data?.pages[0]?.manualMediaCount || 0}
                        mediaUsedBytes={media.data?.pages[0]?.mediaUsedBytes || 0}
                        importBudget={media.data?.pages[0]?.importBudget || null}
                        mediaLoading={
                          mediaOpen &&
                          (media.isPending ||
                            (settledMediaSearch.length > 1 && searchedMedia.isPending))
                        }
                        mediaHasMore={settledMediaSearch.length <= 1 && media.hasNextPage}
                        onLoadMoreMedia={() => void media.fetchNextPage()}
                        onRefreshMedia={() =>
                          void queryClient.invalidateQueries({ queryKey: ["content-brain-media"] })
                        }
                        onImportPost={async (url) => {
                          await requestContentMediaFromPost({ data: { url } });
                          toast.success("Connected post queued for Media.");
                          await refresh();
                        }}
                        onCreateFolder={async (name) => {
                          await createContentMediaFolder({ data: { name } });
                          await refresh();
                        }}
                        onRenameFolder={async (id, name) => {
                          await renameContentMediaFolder({ data: { id, name } });
                          await refresh();
                        }}
                        onDeleteFolder={async (id) => {
                          await deleteContentMediaFolder({ data: { id } });
                          await refresh();
                        }}
                        onMoveMedia={async (id, folderId) => {
                          await moveContentMediaToFolder({ data: { id, folderId } });
                          await refresh();
                        }}
                        onSetHero={async (slot, id) => {
                          await setContentHeroImage({ data: { slot, id } });
                          await refresh();
                        }}
                        onMediaSearch={setMediaSearch}
                        onReviewOldMedia={() => previewOldContentMedia()}
                        indexing={data.indexing}
                        building={buildBrain.isPending}
                        onBuildBrain={byokOnly ? undefined : () => buildBrain.mutate()}
                        onSaveProfile={async (value) => {
                          await profileMutation.mutateAsync(value);
                        }}
                        onSaveItem={async (value) => {
                          await itemMutation.mutateAsync(value);
                        }}
                        onConfirm={(id) => confirmMutation.mutate(id)}
                        onLock={(id, locked) => lockMutation.mutate({ id, locked })}
                        onDelete={(id) => deleteMutation.mutate(id)}
                        onUpload={upload}
                      />
                    )}
                  </BennyMemory>
                ) : (
                  <MicroAppPanel className="p-6">
                    <div role="status" aria-label="Loading Content Brain">
                      Loading your Content Brain…
                    </div>
                  </MicroAppPanel>
                ))}
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </main>
  );
}

function useContentMutation<T>(
  mutationFn: (value: T) => Promise<unknown>,
  onSuccess: () => Promise<unknown>,
) {
  return useMutation({
    mutationFn,
    onSuccess,
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Content could not be saved."),
  });
}

function EmptyWorkspace({
  eyebrow,
  title,
  description,
  onRetry,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <MicroAppPanel className="p-7 sm:p-10">
      <p className={micro.eyebrow}>{eyebrow}</p>
      <h2 className="mt-1 font-ui-display text-3xl text-[#17213a]">{title}</h2>
      <p className={`mt-2 max-w-xl ${micro.muted}`}>{description}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className={`${micro.btnPrimary} mt-5`}>
          Try again
        </button>
      )}
    </MicroAppPanel>
  );
}
