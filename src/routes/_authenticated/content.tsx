import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { z } from "zod";
import "@/components/content/content-workspace.css";
import { AppHeader } from "@/components/AppHeader";
import {
  ContentAgent,
  type ContentAgentMessage,
  type ContentAgentThread,
} from "@/components/content/ContentAgent";
import { ContentBrain, type ContentBrainSection } from "@/components/content/ContentBrain";
import { ContentDiscover } from "@/components/content/ContentDiscover";
import { ContentRoutines, type ContentRoutineView } from "@/components/content/ContentRoutines";
import { MicroAppPanel } from "@/components/MicroAppPanel";
import {
  confirmBrainItem,
  deleteBrainItem,
  getContentBrain,
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
  listContentAgentThreads,
  regenerateAgentDraft,
  rejectAgentDraft,
  sendContentAgentMessage,
  saveAgentDraft,
} from "@/lib/content-agent.functions";
import {
  getContentDiscover,
  mergeDiscoverRefresh,
  refreshContentDiscover,
  saveDiscoverItem,
  setDiscoverFeedback,
  type ContentDiscoverData,
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

type ContentTab = "discover" | "agent" | "brain";

const contentSearchSchema = z.object({
  tab: z.enum(["discover", "agent", "brain"]).optional().catch("discover"),
  section: z
    .enum([
      "profile",
      "instruction",
      "strategy",
      "story",
      "library",
      "file",
      "photo",
      "sources",
      "skill",
    ])
    .optional(),
  item: z.string().uuid().optional(),
  platform: z.enum(["twitter", "linkedin"]).optional(),
  routines: z
    .union([z.literal(true), z.literal("true")])
    .transform(() => true)
    .optional()
    .catch(false),
});

export const Route = createFileRoute("/_authenticated/content")({
  validateSearch: contentSearchSchema,
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: ({ context }) =>
    context.queryClient.prefetchQuery({
      queryKey: ["content-brain"],
      queryFn: () => getContentBrain(),
    }),
  head: () => ({ meta: [{ title: "Content | bento.surf" }] }),
  component: ContentRoutePage,
});

function ContentRoutePage() {
  const { tab = "discover", routines = false, section, item, platform } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <ContentPage
      initialTab={tab}
      initialRoutines={routines}
      initialBrainSection={section}
      initialBrainItem={item}
      initialBrainPlatform={platform}
      onBrainNavigate={(section, item, platform) =>
        void navigate({
          to: "/content",
          search: { tab: "brain", section, item: item || undefined, platform },
        })
      }
      onTabChange={(next) => void navigate({ to: "/content", search: { tab: next } })}
      onRoutinesChange={(open) =>
        void navigate({
          to: "/content",
          search: open ? { tab: "agent", routines: true } : { tab: "agent" },
        })
      }
    />
  );
}

export function ContentPage({
  initialTab = "discover",
  initialRoutines = false,
  initialBrainSection,
  initialBrainItem,
  initialBrainPlatform,
  onBrainNavigate,
  onTabChange,
  onRoutinesChange,
}: {
  initialTab?: ContentTab;
  initialRoutines?: boolean;
  initialBrainSection?: ContentBrainSection;
  initialBrainItem?: string;
  initialBrainPlatform?: "twitter" | "linkedin";
  onBrainNavigate?: (
    section: ContentBrainSection,
    item: string | null,
    platform: "twitter" | "linkedin",
  ) => void;
  onTabChange?: (tab: ContentTab) => void;
  onRoutinesChange?: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<ContentTab>(initialTab);
  const [mediaSearch, setMediaSearch] = useState("");
  const [settledMediaSearch, setSettledMediaSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettledMediaSearch(mediaSearch), 300);
    return () => clearTimeout(timer);
  }, [mediaSearch]);
  const [agentSeed, setAgentSeed] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<string | null | undefined>(undefined);
  const [showRoutines, setShowRoutines] = useState(initialRoutines);
  const queryClient = useQueryClient();

  useEffect(() => {
    setTab(initialTab);
    setShowRoutines(initialRoutines);
  }, [initialRoutines, initialTab]);
  const brain = useQuery({
    queryKey: ["content-brain"],
    queryFn: () => getContentBrain(),
    refetchInterval: (query) =>
      ["pending", "running"].includes(query.state.data?.indexing?.status || "") ? 5000 : false,
  });
  const searchedMedia = useQuery({
    queryKey: ["content-media-search", settledMediaSearch],
    queryFn: () => searchContentBrainMedia({ data: { query: settledMediaSearch } }),
    enabled: tab === "brain" && settledMediaSearch.length > 1,
  });
  const discover = useQuery({
    queryKey: ["content-discover"],
    queryFn: () => getContentDiscover(),
    enabled: tab === "discover",
  });
  const discoverRefreshRequested = useRef(false);
  const researchDiscover = useMutation({
    mutationFn: () => refreshContentDiscover(),
    onSuccess: (result) =>
      queryClient.setQueryData<ContentDiscoverData>(["content-discover"], (current) =>
        mergeDiscoverRefresh(current, result),
      ),
  });
  useEffect(() => {
    if (
      tab !== "discover" ||
      !discover.data ||
      !["missing", "stale"].includes(discover.data.status) ||
      discoverRefreshRequested.current
    ) {
      return;
    }
    discoverRefreshRequested.current = true;
    researchDiscover.mutate();
  }, [discover.data, researchDiscover, tab]);
  const threads = useQuery({
    queryKey: ["content-agent-threads"],
    queryFn: () => listContentAgentThreads(),
    enabled: tab === "agent",
  });
  const resolvedThreadId =
    activeThreadId === undefined ? threads.data?.[0]?.id || null : activeThreadId;
  const thread = useQuery({
    queryKey: ["content-agent-thread", resolvedThreadId],
    queryFn: () => getContentAgentThread({ data: { threadId: resolvedThreadId as string } }),
    enabled: tab === "agent" && Boolean(resolvedThreadId),
  });
  const routines = useQuery({
    queryKey: ["content-routines"],
    queryFn: () => getContentRoutines(),
    enabled: tab === "agent" && showRoutines,
  });

  const routineActivity = useQuery({
    queryKey: ["content-routine-activity"],
    queryFn: () => getContentRoutineActivity(),
    enabled: tab === "agent" && showRoutines,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["content-brain"] });
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
  const saveRecommendation = useContentMutation(
    (id: string) => saveDiscoverItem({ data: { id } }),
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
  const sendAgentMessage = useMutation({
    mutationFn: (text: string) =>
      sendContentAgentMessage({ data: { threadId: resolvedThreadId, text } }),
    onSuccess: async (result) => {
      setActiveThreadId(result.threadId);
      setAgentSeed("");
      if (result.memoriesSaved) toast.success("Memory saved to My Human.");
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
    (value: { messageId: string; cardId: string; body: string }) => saveAgentDraft({ data: value }),
    refreshAgent,
  );
  const approveSchedule = useContentMutation(
    (value: { messageId: string; draftCardId: string; scheduleCardId: string }) =>
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
    setTab(next);
    setShowRoutines(false);
    onTabChange?.(next);
  };

  const changeRoutines = (open: boolean) => {
    setShowRoutines(open);
    onRoutinesChange?.(open);
  };

  const openAgent = (item: DiscoverRecommendation, createDraft: boolean) => {
    setActiveThreadId(null);
    setAgentSeed(
      createDraft
        ? `Create a platform-native draft from this source: ${item.title}\n${item.sourceUrl || ""}`
        : `Help me explore this idea: ${item.title}\n${item.sourceUrl || ""}`,
    );
    changeTab("agent");
  };

  const upload = async (file: File, kind: "file" | "photo") => {
    try {
      const uploaded = await uploadFileResult(file, kind === "photo" ? "image" : "file");
      if (!uploaded.publicUrl) throw new Error("Upload did not return a public URL.");
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
  return (
    <main
      className={
        tab === "discover"
          ? micro.shell
          : "content-workspace min-h-[calc(100dvh-3.5rem)] lg:min-h-screen"
      }
    >
      <AppHeader
        title={
          tab === "brain"
            ? "Brain"
            : tab === "agent"
              ? showRoutines
                ? "Routines"
                : "Agent"
              : "Content"
        }
      />
      <div className={tab === "discover" ? micro.main : ""}>
        <div>
          {tab === "discover" &&
            (discover.isError ? (
              <EmptyWorkspace
                eyebrow="Discover"
                title="Discover could not load."
                description="Your saved recommendations are safe. Try loading them again."
                onRetry={() => void discover.refetch()}
              />
            ) : discover.data ? (
              <ContentDiscover
                data={discover.data}
                refreshing={researchDiscover.isPending}
                refreshError={
                  researchDiscover.error
                    ? researchDiscover.error instanceof Error
                      ? researchDiscover.error.message
                      : "Recommendations could not be refreshed."
                    : null
                }
                onRefresh={() => researchDiscover.mutate()}
                onLike={(id) => likeRecommendation.mutate(id)}
                onSave={(id) => saveRecommendation.mutate(id)}
                onReject={(id) => rejectRecommendation.mutate(id)}
                onAskAgent={(item) => openAgent(item, false)}
                onCreateDraft={(item) => openAgent(item, true)}
              />
            ) : (
              <EmptyWorkspace
                eyebrow="Discover"
                title="Finding ideas grounded in what works."
                description="Bento is checking your winners and current niche sources."
              />
            ))}
          {tab === "agent" &&
            (showRoutines ? (
              <ContentRoutines
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
            ) : (
              <ContentAgent
                threads={(threads.data || []) as ContentAgentThread[]}
                activeThreadId={resolvedThreadId}
                messages={(thread.data?.messages || []) as ContentAgentMessage[]}
                seed={agentSeed}
                brainEmpty={!brain.data?.items.length}
                sending={sendAgentMessage.isPending}
                onNewThread={() => {
                  setActiveThreadId(null);
                  setAgentSeed("");
                }}
                onSelectThread={setActiveThreadId}
                onSend={async (text) => {
                  await sendAgentMessage.mutateAsync(text);
                }}
                onSaveDraft={async (messageId, cardId, body) => {
                  await saveDraft.mutateAsync({ messageId, cardId, body });
                }}
                onBuildBrain={() => buildBrain.mutate()}
                onApproveBrain={(messageId, cardId) => approveBrain.mutate({ messageId, cardId })}
                onRejectDraft={(messageId, cardId, reason) =>
                  rejectDraft.mutate({ messageId, cardId, reason })
                }
                onRegenerateDraft={(messageId, cardId, reason) =>
                  regenerateDraft.mutate({ messageId, cardId, reason })
                }
                onApproveSchedule={(messageId, draftCardId, scheduleCardId) =>
                  approveSchedule.mutate({ messageId, draftCardId, scheduleCardId })
                }
              />
            ))}
          {tab === "brain" &&
            (data ? (
              <ContentBrain
                initialSection={initialBrainSection}
                initialItemId={initialBrainItem}
                initialPlatform={initialBrainPlatform}
                onNavigate={onBrainNavigate}
                profile={data.profile}
                items={data.items}
                sources={data.sources}
                photos={
                  settledMediaSearch.length > 1
                    ? searchedMedia.data || data.photos || []
                    : data.photos || []
                }
                onMediaSearch={setMediaSearch}
                indexing={data.indexing}
                building={buildBrain.isPending}
                onBuildBrain={() => buildBrain.mutate()}
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
            ) : (
              <MicroAppPanel className="p-6">
                <div role="status" aria-label="Loading Content Brain">
                  Loading your Content Brain…
                </div>
              </MicroAppPanel>
            ))}
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
