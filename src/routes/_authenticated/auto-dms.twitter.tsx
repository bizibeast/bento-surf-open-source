import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  Beaker,
  CheckCircle2,
  Heart,
  History,
  ListChecks,
  LoaderCircle,
  Mail,
  MessageCircleReply,
  MessagesSquare,
  Pencil,
  RefreshCw,
  Repeat2,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { SiX } from "react-icons/si";
import { toast } from "sonner";
import { z } from "zod";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { AppHeader } from "@/components/AppHeader";
import { DmAutomationPlatformNav } from "@/components/DmAutomationPlatformNav";
import { MicroAppPanel, MicroAppStatCard, MicroAppTabMotion } from "@/components/MicroAppPanel";
import { MicroAppTabs } from "@/components/MicroAppTabs";
import { Switch } from "@/components/ui/switch";
import { SettingsIntegrationsLink } from "@/components/settings/SettingsIntegrationsLink";
import { TwitterAutoDmConnect } from "@/components/settings/TwitterAutoDmConnect";
import { createAutoDmWebMcpTools } from "@/lib/auto-dm-webmcp";
import { micro } from "@/lib/micro-app-ui";
import {
  deleteTwitterAutoDmAutomation,
  enableTwitterAutoDmDelivery,
  getTwitterAutoDmDashboard,
  preflightTwitterAutoDmAutomation,
  saveTwitterAutoDmAutomation,
  setTwitterAutoDmEnabled,
} from "@/lib/twitter-auto-dm.functions";
import type {
  TwitterDmActivity,
  TwitterDmAutomation,
  TwitterDmMatchType,
  TwitterDmTriggerType,
} from "@/lib/twitter-auto-dm";
import { testTwitterAutomation, TWITTER_KEYWORDLESS_TRIGGER_TYPES } from "@/lib/twitter-auto-dm";
import {
  getTwitterAutoDmOnboardingStep,
  getTwitterAutoDmStarterTemplate,
  TWITTER_AUTO_DM_STARTER_TEMPLATES,
  type TwitterAutoDmStarterTemplateId,
} from "@/lib/twitter-auto-dm-onboarding";
import { useWebMcpTools } from "@/lib/webmcp";

const twitterAutoDmTabSchema = z.enum(["automations", "activity", "settings"]);

export const Route = createFileRoute("/_authenticated/auto-dms/twitter")({
  head: () => ({ meta: [{ title: "X Auto-DM | bento.surf" }] }),
  validateSearch: z.object({
    tab: twitterAutoDmTabSchema.default("automations").catch("automations"),
  }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["twitter-auto-dm"],
      queryFn: () => getTwitterAutoDmDashboard(),
    });
  },
  component: TwitterAutoDmPage,
});

const twitterAutoDmTabs = [
  { id: "automations", label: "Automations", icon: ListChecks },
  { id: "activity", label: "Activity", icon: History },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

type Draft = {
  id?: string;
  connectionId: string;
  name: string;
  triggerType: TwitterDmTriggerType;
  keywords: string;
  excludedKeywords: string;
  matchType: TwitterDmMatchType;
  replyMessage: string;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  connectionId: "",
  name: "Send link from replies",
  triggerType: "mention_keyword",
  keywords: "link",
  excludedKeywords: "",
  matchType: "contains",
  replyMessage: "Thanks for the reply! Here is the link you asked for ✨",
  enabled: true,
};

function basicTwitterDraft(draft: Draft): Draft {
  return { ...draft, excludedKeywords: "" };
}

const TWITTER_ONBOARDING_DISMISSED_KEY = "bento:twitter-auto-dm-onboarding-dismissed:v1";

function TwitterAutoDmPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["twitter-auto-dm"],
    queryFn: () => getTwitterAutoDmDashboard(),
    refetchInterval: 30_000,
  });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [onboardingPreferenceLoaded, setOnboardingPreferenceLoaded] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] =
    useState<TwitterAutoDmStarterTemplateId | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const updateDraft = (next: Draft) =>
    setDraft(data?.advancedAutoDm ? next : basicTwitterDraft(next));

  useEffect(() => {
    setOnboardingDismissed(
      window.localStorage.getItem(TWITTER_ONBOARDING_DISMISSED_KEY) === "true",
    );
    setOnboardingPreferenceLoaded(true);
  }, []);

  const connections = data?.connections || [];
  const readyConnections = connections.filter((connection) => connection.ready);
  const sentCount = (data?.activity || []).filter(
    (event: TwitterDmActivity) => event.status === "sent",
  ).length;
  const activeCount = (data?.automations || []).filter(
    (automation: TwitterDmAutomation) => automation.enabled,
  ).length;
  const setTab = (nextTab: (typeof twitterAutoDmTabs)[number]["id"]) =>
    void navigate({
      to: "/auto-dms/twitter",
      search: { tab: nextTab },
      replace: true,
    });

  const save = useMutation({
    mutationFn: () =>
      saveTwitterAutoDmAutomation({
        data: {
          id: draft.id,
          connectionId: draft.connectionId,
          name: draft.name,
          triggerType: draft.triggerType,
          keywords: splitList(draft.keywords),
          excludedKeywords: data?.advancedAutoDm ? splitList(draft.excludedKeywords) : [],
          matchType: draft.matchType,
          replyMessage: draft.replyMessage,
          enabled: draft.enabled,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] });
      setEditorOpen(false);
      if (!draft.id) {
        setOnboardingCompleted(true);
        window.localStorage.setItem(TWITTER_ONBOARDING_DISMISSED_KEY, "true");
        setOnboardingDismissed(true);
      }
      toast.success(draft.id ? "Automation updated" : "Automation saved");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save this automation"),
  });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setTwitterAutoDmEnabled({ data: { id, enabled } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] }),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update this automation"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteTwitterAutoDmAutomation({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] });
      toast.success("Automation deleted");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not delete this automation"),
  });
  const subscribe = useMutation({
    mutationFn: (connectionId: string) => enableTwitterAutoDmDelivery({ data: { connectionId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] });
      toast.success("X Auto-DM connection verified");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not verify this X account"),
  });
  const preflight = useMutation({
    mutationFn: (id: string) => preflightTwitterAutoDmAutomation({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] });
      toast.success("Preflight passed");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Preflight failed"),
  });

  useWebMcpTools(
    createAutoDmWebMcpTools({
      platform: "twitter",
      loadDashboard: () => getTwitterAutoDmDashboard(),
      preflight: (automationId) => preflightTwitterAutoDmAutomation({ data: { id: automationId } }),
      repairConnection: (connectionId) => enableTwitterAutoDmDelivery({ data: { connectionId } }),
      onDashboard: (next) => queryClient.setQueryData(["twitter-auto-dm"], next),
    }),
  );

  function openNew() {
    updateDraft({
      ...EMPTY_DRAFT,
      connectionId: readyConnections[0]?.id || connections[0]?.id || "",
    });
    setEditorOpen(true);
  }
  function chooseStarterTemplate(templateId: TwitterAutoDmStarterTemplateId) {
    const template = getTwitterAutoDmStarterTemplate(templateId);
    setSelectedTemplateId(templateId);
    updateDraft({
      ...EMPTY_DRAFT,
      ...template.draft,
      connectionId: readyConnections[0]?.id || connections[0]?.id || "",
    });
    setEditorOpen(true);
  }
  function skipOnboarding() {
    window.localStorage.setItem(TWITTER_ONBOARDING_DISMISSED_KEY, "true");
    setOnboardingDismissed(true);
  }
  function reopenOnboarding() {
    window.localStorage.removeItem(TWITTER_ONBOARDING_DISMISSED_KEY);
    setOnboardingDismissed(false);
    setSelectedTemplateId(null);
  }
  function edit(automation: TwitterDmAutomation) {
    updateDraft({
      id: automation.id,
      connectionId: automation.connectionId,
      name: automation.name,
      triggerType: automation.triggerType,
      keywords: automation.keywords.join(", "),
      excludedKeywords: automation.excludedKeywords.join(", "),
      matchType: automation.matchType,
      replyMessage: automation.replyMessage,
      enabled: automation.enabled,
    });
    setEditorOpen(true);
  }

  const hasAutomations = Boolean(data?.automations.length);
  const showOnboarding =
    onboardingPreferenceLoaded &&
    !data?.locked &&
    !hasAutomations &&
    !onboardingDismissed &&
    !onboardingCompleted;

  return (
    <main className={`relative overflow-x-clip ${micro.shell}`}>
      <AppHeader
        title="X Auto-DM"
        actions={
          !data?.locked && !showOnboarding && !onboardingCompleted ? (
            connections.length ? (
              <button type="button" onClick={openNew} className={micro.btnPrimaryCompact}>
                <Sparkles className="size-4" /> New Auto-DM
              </button>
            ) : (
              <SettingsIntegrationsLink integration="automation" compact>
                Connect X
              </SettingsIntegrationsLink>
            )
          ) : undefined
        }
      />

      <div className={micro.main}>
        <DmAutomationPlatformNav current="twitter" />
        {!isLoading && !data?.advancedAutoDm && (
          <div
            className={`${micro.bannerInfo} mb-6 flex flex-wrap items-center justify-between gap-3`}
          >
            <p className="text-sm">
              Free includes unlimited Trigger → message automations. Store unlocks advanced
              exclusions and conditions.
            </p>
            <UpgradeDialog feature="advancedAutoDM" />
          </div>
        )}
        {!isLoading &&
          !data?.locked &&
          !showOnboarding &&
          !onboardingCompleted &&
          tab === "automations" && (
            <div className="mb-8 grid gap-4 sm:grid-cols-3">
              <StatCard icon={Bot} label="Active automations" value={activeCount} />
              <StatCard icon={Mail} label="DMs sent recently" value={sentCount} />
              <StatCard icon={SiX} label="Connected accounts" value={readyConnections.length} />
            </div>
          )}

        {isLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <LoaderCircle className="size-8 animate-spin text-primary" />
          </div>
        ) : data?.locked ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <MicroAppPanel className="text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#111111] text-white">
                <SiX className="size-6" />
              </div>
              <h2 className="mt-5 font-ui-display text-3xl">Turn engagement into conversations</h2>
              <p className={`mx-auto mt-2 max-w-lg ${micro.muted}`}>
                X Auto DMs are included with every Bento plan.
              </p>
              <div className="mt-6 flex justify-center">
                <UpgradeDialog feature="twitterAutoDM" />
              </div>
            </MicroAppPanel>
          </div>
        ) : isError ? (
          <MicroAppPanel>
            <p className="text-sm text-rose-600">
              X Auto-DM could not load. Please refresh and try again.
            </p>
          </MicroAppPanel>
        ) : showOnboarding ? (
          <TwitterAutoDmOnboarding
            connections={connections}
            selectedTemplateId={selectedTemplateId}
            draft={draft}
            setDraft={updateDraft}
            saving={save.isPending}
            repairing={subscribe.isPending}
            configured={Boolean(data?.configured)}
            onChooseTemplate={chooseStarterTemplate}
            onBackToTemplates={() => {
              setSelectedTemplateId(null);
              setEditorOpen(false);
            }}
            onRepair={(connectionId) => subscribe.mutate(connectionId)}
            onSave={() => save.mutate()}
            onSkip={skipOnboarding}
          />
        ) : onboardingCompleted ? (
          <MicroAppPanel className="text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
              <CheckCircle2 className="size-7" />
            </div>
            <h2 className="mt-5 font-ui-display text-3xl">Your first X Auto-DM is live</h2>
            <p className={`mx-auto mt-2 max-w-lg ${micro.muted}`}>
              Bento will reply through X’s official API when the rule matches. Use Test rule before
              a live reply, like, repost, or DM from another account.
            </p>
            <button
              type="button"
              onClick={() => setOnboardingCompleted(false)}
              className={`${micro.btnPrimary} mt-6`}
            >
              Continue
            </button>
          </MicroAppPanel>
        ) : (
          <div className="space-y-6">
            <MicroAppTabs
              tabs={twitterAutoDmTabs.map((item) => ({
                ...item,
                count:
                  item.id === "automations"
                    ? data?.automations.length || 0
                    : item.id === "activity"
                      ? data?.activity.length || 0
                      : undefined,
              }))}
              value={tab}
              onChange={setTab}
            />
            <MicroAppTabMotion tabKey={tab}>
              {tab === "automations" ? (
                <MicroAppPanel className="overflow-hidden">
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className={micro.eyebrow}>Automations</p>
                      <h2 className="mt-1 font-ui-display text-3xl">
                        Turn replies, likes, and DMs into conversations.
                      </h2>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                        Reply when someone replies, likes, or reposts your post, or sends you a DM.
                        Bento never starts cold DMs.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={openNew}
                      disabled={!connections.length}
                      className={micro.btnPrimary}
                    >
                      <Sparkles className="size-4" /> New Auto-DM
                    </button>
                  </div>
                  {editorOpen && (
                    <AutomationEditor
                      draft={draft}
                      setDraft={updateDraft}
                      connections={connections}
                      saving={save.isPending}
                      onCancel={() => setEditorOpen(false)}
                      onSave={() => save.mutate()}
                    />
                  )}
                  <div className="mt-6 space-y-3">
                    {(data?.automations || []).length ? (
                      data?.automations.map((automation: TwitterDmAutomation) => (
                        <AutomationRow
                          key={automation.id}
                          automation={automation}
                          busy={toggle.isPending || remove.isPending || preflight.isPending}
                          onEdit={() => edit(automation)}
                          onPreflight={() => preflight.mutate(automation.id)}
                          onToggle={(enabled) => toggle.mutate({ id: automation.id, enabled })}
                          onDelete={() => {
                            if (window.confirm(`Delete “${automation.name}”?`)) {
                              remove.mutate(automation.id);
                            }
                          }}
                        />
                      ))
                    ) : (
                      <div className={micro.empty}>
                        <Bot className="mx-auto size-7 text-muted-foreground" />
                        <p className="mt-3 text-sm font-semibold">No automations yet</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Connect X in Settings, then create a rule for replies, likes, reposts, or
                          DMs.
                        </p>
                        {connections.length ? (
                          <button
                            type="button"
                            onClick={reopenOnboarding}
                            className={`${micro.btnInk} mt-4 px-4 py-2.5 text-xs`}
                          >
                            Open setup guide
                          </button>
                        ) : (
                          <SettingsIntegrationsLink
                            integration="automation"
                            className={`${micro.btnInk} mt-4 px-4 py-2.5 text-xs`}
                            icon={<SiX className="size-3.5" />}
                          >
                            Connect X
                          </SettingsIntegrationsLink>
                        )}
                      </div>
                    )}
                  </div>
                </MicroAppPanel>
              ) : tab === "activity" ? (
                <MicroAppPanel>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className={micro.eyebrow}>Activity</p>
                      <h2 className="mt-1 font-ui-display text-2xl">Recent replies</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] })
                      }
                      className={`${micro.btnSoft} size-10 px-0`}
                      aria-label="Refresh activity"
                    >
                      <RefreshCw className="size-4" />
                    </button>
                  </div>
                  <div className="mt-5 divide-y divide-border/65">
                    {(data?.activity || []).length ? (
                      data?.activity.map((event: TwitterDmActivity) => (
                        <ActivityRow key={event.id} event={event} />
                      ))
                    ) : (
                      <div
                        className={`${micro.soft} px-5 py-8 text-center text-sm text-muted-foreground`}
                      >
                        Replies and delivery attempts will appear here.
                      </div>
                    )}
                  </div>
                </MicroAppPanel>
              ) : (
                <div className="mx-auto w-full max-w-3xl">
                  <MicroAppPanel>
                    <div className="flex size-14 items-center justify-center rounded-[20px] bg-[#111111] text-white shadow-lg">
                      <SiX className="size-7" />
                    </div>
                    <p className={`mt-5 ${micro.eyebrowMuted}`}>X connection</p>
                    <h2 className="mt-1 font-ui-display text-2xl">
                      Official API. No pasted passwords.
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Auto-DM uses X OAuth and Direct Message scopes. Reconnect once to approve DM
                      access if this account was connected before Auto-DM launched.
                    </p>
                    <div className="mt-6 space-y-3">
                      {connections.map((connection) => (
                        <div
                          key={connection.id}
                          className="rounded-[22px] border border-black/[0.07] bg-white p-4"
                        >
                          <div className="flex flex-col gap-3 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold">
                                @{connection.handle}
                              </div>
                              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                {connection.ready ? (
                                  <>
                                    <CheckCircle2 className="size-3.5 text-emerald-500" /> Ready
                                  </>
                                ) : connection.needsReconnect ? (
                                  <>Reconnect required</>
                                ) : (
                                  <>Verification required</>
                                )}
                              </div>
                              {!connection.ready &&
                                (connection.readinessMessage || connection.lastError) && (
                                  <p className="mt-1 text-xs leading-4 text-rose-600">
                                    {connection.readinessMessage || connection.lastError}
                                  </p>
                                )}
                            </div>
                            {!connection.needsReconnect && (
                              <button
                                type="button"
                                onClick={() => subscribe.mutate(connection.id)}
                                disabled={subscribe.isPending}
                                className={`${micro.btnSoft} rounded-xl px-3 py-2 text-xs`}
                              >
                                {connection.ready ? "Recheck" : "Repair"}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                      <TwitterAutoDmConnect
                        connections={connections.map((connection) => ({
                          id: connection.id,
                          displayName: `@${connection.handle}`,
                          canAutomate: !connection.needsReconnect,
                        }))}
                        ready={Boolean(data?.configured)}
                        onChanged={() =>
                          void queryClient.invalidateQueries({ queryKey: ["twitter-auto-dm"] })
                        }
                      />
                    </div>
                    {!data?.configured && (
                      <div className="mt-5 rounded-2xl bg-amber-500/10 p-4 text-xs leading-5 text-amber-800">
                        X Auto-DM still needs its server configuration before replies can go live.
                      </div>
                    )}
                    <div className={`${micro.soft} mt-5 p-4 text-xs leading-5 text-[#17213a]/70`}>
                      Bento uses X’s official API. Recipients must be able to receive DMs. There is
                      no paid Auto-DM add-on.
                    </div>
                  </MicroAppPanel>
                </div>
              )}
            </MicroAppTabMotion>
          </div>
        )}
      </div>
    </main>
  );
}

type TwitterOnboardingConnection = {
  id: string;
  handle: string;
  ready: boolean;
  needsReconnect: boolean;
};

function TwitterAutoDmOnboarding({
  connections,
  selectedTemplateId,
  draft,
  setDraft,
  saving,
  repairing,
  configured,
  onChooseTemplate,
  onBackToTemplates,
  onRepair,
  onSave,
  onSkip,
}: {
  connections: TwitterOnboardingConnection[];
  selectedTemplateId: TwitterAutoDmStarterTemplateId | null;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  saving: boolean;
  repairing: boolean;
  configured: boolean;
  onChooseTemplate: (id: TwitterAutoDmStarterTemplateId) => void;
  onBackToTemplates: () => void;
  onRepair: (connectionId: string) => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const readyConnection = connections.find((connection) => connection.ready);
  const step = getTwitterAutoDmOnboardingStep({
    hasReadyConnection: Boolean(readyConnection),
    selectedTemplateId,
  });
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <MicroAppPanel>
        <p className={micro.eyebrow}>Set up X Auto-DM</p>
        <h2 className="mt-1 font-ui-display text-3xl">
          {step === "connect"
            ? "Connect X"
            : step === "template"
              ? "Choose a starter"
              : "Customize the reply"}
        </h2>
        {step === "connect" && (
          <div className="mt-6 space-y-4">
            <TwitterAutoDmConnect
              connections={connections.map((connection) => ({
                id: connection.id,
                displayName: `@${connection.handle}`,
                canAutomate: !connection.needsReconnect,
              }))}
              ready={configured}
              onChanged={() => undefined}
            />
            {connections.map((connection) =>
              !connection.ready && !connection.needsReconnect ? (
                <button
                  key={connection.id}
                  type="button"
                  onClick={() => onRepair(connection.id)}
                  disabled={repairing}
                  className={micro.btnOutline}
                >
                  Repair @{connection.handle}
                </button>
              ) : null,
            )}
            <button type="button" onClick={onSkip} className="text-xs text-[#17213a]/45">
              Skip for now
            </button>
          </div>
        )}
        {step === "template" && (
          <div className="mt-6 grid gap-3">
            {TWITTER_AUTO_DM_STARTER_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => onChooseTemplate(template.id)}
                className="rounded-[24px] border border-black/[0.07] bg-white p-4 text-left transition hover:-translate-y-0.5 hover:bg-[#f8faff]"
              >
                <p className={micro.eyebrowMuted}>
                  {template.emoji} {template.eyebrow}
                </p>
                <h3 className="mt-1 font-semibold">{template.name}</h3>
                <p className={`mt-1 ${micro.mutedXs}`}>{template.description}</p>
              </button>
            ))}
            <button type="button" onClick={onSkip} className="text-xs text-[#17213a]/45">
              Skip for now
            </button>
          </div>
        )}
        {step === "customize" && (
          <div className="mt-6 space-y-4">
            <AutomationEditor
              draft={draft}
              setDraft={setDraft}
              connections={connections}
              saving={saving}
              onCancel={onBackToTemplates}
              onSave={onSave}
            />
          </div>
        )}
      </MicroAppPanel>
    </div>
  );
}

function AutomationEditor({
  draft,
  setDraft,
  connections,
  saving,
  onCancel,
  onSave,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  connections: Array<{ id: string; handle: string; ready: boolean }>;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const family = triggerFamily(draft.triggerType);
  const needsKeywords = !(TWITTER_KEYWORDLESS_TRIGGER_TYPES as readonly string[]).includes(
    draft.triggerType,
  );
  const canSave =
    draft.connectionId &&
    draft.name.trim() &&
    draft.replyMessage.trim() &&
    (!needsKeywords || splitList(draft.keywords).length > 0);

  function selectFamily(nextFamily: TriggerFamily) {
    setDraft({
      ...draft,
      triggerType:
        nextFamily === "mention"
          ? "mention_keyword"
          : nextFamily === "dm"
            ? "dm_keyword"
            : nextFamily === "like"
              ? "any_like"
              : "any_retweet",
      keywords: nextFamily === "like" || nextFamily === "retweet" ? "" : draft.keywords,
    });
  }

  return (
    <div className="mt-6 rounded-[28px] border border-black/[0.07] bg-[#f8faff] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-ui-display text-xl">{draft.id ? "Edit automation" : "New Auto-DM"}</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close editor"
          className={micro.btnSoft}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-5 grid gap-4">
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            className={micro.input}
          />
        </Field>
        <Field label="Account">
          <select
            value={draft.connectionId}
            onChange={(event) => setDraft({ ...draft, connectionId: event.target.value })}
            className={micro.input}
          >
            <option value="">Choose an X account</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                @{connection.handle}
                {connection.ready ? "" : " (needs attention)"}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <p className={`mb-2 ${micro.eyebrowMuted}`}>When someone</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <TriggerChoice
              selected={family === "mention"}
              icon={<MessageCircleReply className="size-4" />}
              label="Replies to your post"
              onClick={() => selectFamily("mention")}
            />
            <TriggerChoice
              selected={family === "like"}
              icon={<Heart className="size-4" />}
              label="Likes your post"
              onClick={() => selectFamily("like")}
            />
            <TriggerChoice
              selected={family === "retweet"}
              icon={<Repeat2 className="size-4" />}
              label="Reposts your post"
              onClick={() => selectFamily("retweet")}
            />
            <TriggerChoice
              selected={family === "dm"}
              icon={<MessagesSquare className="size-4" />}
              label="Sends you a DM"
              onClick={() => selectFamily("dm")}
            />
          </div>
        </div>
        {family === "like" || family === "retweet" ? (
          <p className="text-sm leading-6 text-[#17213a]/65">
            This sends a DM to each person who {family === "like" ? "likes" : "reposts"} your post.
            They must be able to receive DMs from you.
          </p>
        ) : (
          <>
            <label className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3">
              <span className="text-sm font-medium">
                Match any {family === "dm" ? "DM" : "reply"}
              </span>
              <Switch
                checked={!needsKeywords}
                onCheckedChange={(checked) =>
                  setDraft({
                    ...draft,
                    triggerType: checked
                      ? family === "dm"
                        ? "any_dm"
                        : "any_mention"
                      : family === "dm"
                        ? "dm_keyword"
                        : "mention_keyword",
                  })
                }
              />
            </label>
            {needsKeywords && (
              <>
                <Field label="Keywords" hint="Comma separated">
                  <input
                    value={draft.keywords}
                    onChange={(event) => setDraft({ ...draft, keywords: event.target.value })}
                    className={micro.input}
                    placeholder="link, info"
                  />
                </Field>
                <Field label="Match">
                  <select
                    value={draft.matchType}
                    onChange={(event) =>
                      setDraft({ ...draft, matchType: event.target.value as TwitterDmMatchType })
                    }
                    className={micro.input}
                  >
                    <option value="contains">Contains</option>
                    <option value="exact">Exact</option>
                  </select>
                </Field>
                <Field label="Ignore if it also contains" hint="Optional">
                  <input
                    value={draft.excludedKeywords}
                    onChange={(event) =>
                      setDraft({ ...draft, excludedKeywords: event.target.value })
                    }
                    className={micro.input}
                  />
                </Field>
              </>
            )}
          </>
        )}
        <Field label="DM reply">
          <textarea
            value={draft.replyMessage}
            onChange={(event) => setDraft({ ...draft, replyMessage: event.target.value })}
            className={`${micro.input} min-h-28`}
          />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={micro.btnOutline}>
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave || saving}
          className={micro.btnPrimary}
        >
          {saving ? "Saving…" : "Save Auto-DM"}
        </button>
      </div>
    </div>
  );
}

function TriggerChoice({
  selected,
  icon,
  label,
  onClick,
}: {
  selected: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left text-sm font-medium transition ${
        selected
          ? "border-[#3478f6] bg-white text-[#17213a] shadow-sm"
          : "border-transparent bg-white/60 text-[#17213a]/70"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function AutomationRow({
  automation,
  busy,
  onEdit,
  onPreflight,
  onToggle,
  onDelete,
}: {
  automation: TwitterDmAutomation;
  busy: boolean;
  onEdit: () => void;
  onPreflight: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const [testOpen, setTestOpen] = useState(false);
  const [testText, setTestText] = useState(automation.keywords[0] || "link");
  const testResult = testTwitterAutomation(automation, testText);
  const label =
    automation.triggerType === "any_dm"
      ? "Any DM"
      : automation.triggerType === "dm_keyword"
        ? "DM keyword"
        : automation.triggerType === "any_mention"
          ? "Any reply"
          : automation.triggerType === "any_like"
            ? "Any like"
            : automation.triggerType === "any_retweet"
              ? "Any repost"
              : "Reply keyword";
  const isEngagement =
    automation.triggerType === "any_like" || automation.triggerType === "any_retweet";
  return (
    <article className="rounded-[24px] border border-border/70 bg-background/65 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-sans font-semibold">{automation.name}</h3>
            <span
              className={`${micro.soft} rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground`}
            >
              {label}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">@{automation.connectionHandle}</p>
          {automation.keywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {automation.keywords.map((keyword) => (
                <span
                  key={keyword}
                  className="rounded-full bg-[#dceaff] px-2.5 py-1 text-[11px] font-medium text-[#3478f6]"
                >
                  {keyword}
                </span>
              ))}
            </div>
          )}
        </div>
        <Switch
          checked={automation.enabled}
          disabled={busy}
          onCheckedChange={onToggle}
          aria-label={`Enable ${automation.name}`}
        />
      </div>
      <p className="mt-3 text-sm leading-6 text-[#17213a]/70">{automation.replyMessage}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onEdit} disabled={busy} className={micro.btnOutline}>
          <Pencil className="size-3.5" /> Edit
        </button>
        <button type="button" onClick={onPreflight} disabled={busy} className={micro.btnOutline}>
          Preflight
        </button>
        <button
          type="button"
          onClick={() => setTestOpen((open) => !open)}
          className={micro.btnOutline}
        >
          <Beaker className="size-3.5" /> Test rule
        </button>
        <button
          type="button"
          aria-label={`Delete ${automation.name}`}
          onClick={onDelete}
          disabled={busy}
          className="inline-flex size-9 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-500/10"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {testOpen && (
        <div className="mt-4 rounded-2xl bg-[#f2f5fb] p-4">
          {isEngagement ? (
            <p className="text-xs font-medium">
              This rule matches every {automation.triggerType === "any_like" ? "like" : "repost"} on
              your posts.
            </p>
          ) : (
            <>
              <Field label="Sample text">
                <input
                  value={testText}
                  onChange={(event) => setTestText(event.target.value)}
                  className={micro.input}
                />
              </Field>
              <p className="mt-3 text-xs font-medium">
                {testResult.matches
                  ? `Matches${testResult.matchedKeyword ? ` “${testResult.matchedKeyword}”` : ""}.`
                  : "Does not match."}
              </p>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function ActivityRow({ event }: { event: TwitterDmActivity }) {
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">
          {event.automationName || "X Auto-DM"} · {event.senderLabel}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {event.eventType === "like"
            ? "Like"
            : event.eventType === "retweet"
              ? "Repost"
              : event.eventType === "mention"
                ? "Reply"
                : "DM"}
          {event.matchedKeyword ? ` · ${event.matchedKeyword}` : ""}
          {event.errorMessage ? ` · ${event.errorMessage}` : ""}
        </p>
      </div>
      <EventStatus status={event.status} />
    </div>
  );
}

function EventStatus({ status }: { status: TwitterDmActivity["status"] }) {
  const tone =
    status === "sent"
      ? "bg-emerald-500/10 text-emerald-700"
      : status === "failed"
        ? "bg-rose-500/10 text-rose-700"
        : "bg-[#f2f5fb] text-[#17213a]/65";
  return (
    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase ${tone}`}>
      {status}
    </span>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className={`mb-1.5 flex items-center justify-between gap-3 ${micro.eyebrowMuted}`}>
        {label}
        {hint && <span className="normal-case tracking-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <MicroAppStatCard>
      <div className={`${micro.iconWell} size-9`}>
        <Icon className="size-4" />
      </div>
      <p className="mt-4 text-2xl font-semibold">{value}</p>
      <p className={`mt-1 ${micro.mutedXs}`}>{label}</p>
    </MicroAppStatCard>
  );
}

type TriggerFamily = "mention" | "like" | "retweet" | "dm";

function triggerFamily(trigger: TwitterDmTriggerType): TriggerFamily {
  if (trigger === "dm_keyword" || trigger === "any_dm") return "dm";
  if (trigger === "any_like") return "like";
  if (trigger === "any_retweet") return "retweet";
  return "mention";
}

function splitList(value: string) {
  return value
    .split(/[,|\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
