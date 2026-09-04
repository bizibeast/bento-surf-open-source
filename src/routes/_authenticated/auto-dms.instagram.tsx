import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  Beaker,
  CheckCircle2,
  ChevronDown,
  History,
  Instagram,
  ListChecks,
  LoaderCircle,
  Mail,
  MessageCircleReply,
  MessagesSquare,
  Pencil,
  Radio,
  RefreshCw,
  Send,
  Share2,
  Sparkles,
  SquarePlay,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { SiInstagram } from "react-icons/si";
import { toast } from "sonner";
import { z } from "zod";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { DecodedImage } from "@/components/DecodedImage";
import { AppHeader } from "@/components/AppHeader";
import { DmAutomationPlatformNav } from "@/components/DmAutomationPlatformNav";
import { MicroAppPanel, MicroAppStatCard, MicroAppTabMotion } from "@/components/MicroAppPanel";
import { MicroAppTabs } from "@/components/MicroAppTabs";
import { Switch } from "@/components/ui/switch";
import { micro } from "@/lib/micro-app-ui";
import { SettingsIntegrationsLink } from "@/components/settings/SettingsIntegrationsLink";
import { createAutoDmWebMcpTools } from "@/lib/auto-dm-webmcp";
import {
  deleteInstagramAutoDmAutomation,
  enableInstagramAutoDmWebhooks,
  getInstagramAutoDmDashboard,
  getInstagramAutoDmMedia,
  preflightInstagramAutoDmAutomation,
  saveInstagramAutoDmAutomation,
  setInstagramAutoDmEnabled,
} from "@/lib/instagram-auto-dm.functions";
import type {
  InstagramDmActivity,
  InstagramDmAutomation,
  InstagramDmMatchType,
  InstagramDmMediaScope,
  InstagramDmTriggerType,
  InstagramDmWorkflow,
} from "@/lib/instagram-auto-dm";
import { testInstagramAutomation } from "@/lib/instagram-auto-dm";
import {
  getInstagramAutoDmOnboardingStep,
  getInstagramAutoDmStarterTemplate,
  INSTAGRAM_AUTO_DM_STARTER_TEMPLATES,
  type InstagramAutoDmStarterTemplateId,
} from "@/lib/instagram-auto-dm-onboarding";
import { useWebMcpTools } from "@/lib/webmcp";

const instagramAutoDmTabSchema = z.enum(["automations", "activity", "settings"]);

export const Route = createFileRoute("/_authenticated/auto-dms/instagram")({
  head: () => ({ meta: [{ title: "Instagram Auto-DM | bento.surf" }] }),
  validateSearch: z.object({
    tab: instagramAutoDmTabSchema.default("automations").catch("automations"),
  }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["instagram-auto-dm"],
      queryFn: () => getInstagramAutoDmDashboard(),
    });
  },
  component: InstagramAutoDmPage,
});

const instagramAutoDmTabs = [
  { id: "automations", label: "Automations", icon: ListChecks },
  { id: "activity", label: "Activity", icon: History },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

type Draft = {
  id?: string;
  connectionId: string;
  name: string;
  triggerType: InstagramDmTriggerType;
  keywords: string;
  excludedKeywords: string;
  matchType: InstagramDmMatchType;
  mediaScope: InstagramDmMediaScope;
  mediaIds: string[];
  replyMessage: string;
  publicReplyEnabled: boolean;
  publicReplyMessages: string;
  openingMessage: string;
  confirmationButtonLabel: string;
  emailCaptureEnabled: boolean;
  emailPromptMessage: string;
  emailMarketingConsentEnabled: boolean;
  followGateEnabled: boolean;
  followPromptMessage: string;
  followMaxRechecks: number;
  followFailAction: "send_anyway" | "withhold";
  replyButtonLabel: string;
  replyButtonUrl: string;
  enabled: boolean;
};

const DEFAULT_PUBLIC_REPLY_MESSAGES =
  "Sent it to your DMs ✨\nCheck your messages 💌\nOn its way 🙌";

const EMPTY_DRAFT: Draft = {
  connectionId: "",
  name: "Send link from comments",
  triggerType: "comment_keyword",
  keywords: "link",
  excludedKeywords: "",
  matchType: "contains",
  mediaScope: "any",
  mediaIds: [],
  replyMessage: "Thanks for commenting! Here is the link you asked for ✨",
  publicReplyEnabled: false,
  publicReplyMessages: DEFAULT_PUBLIC_REPLY_MESSAGES,
  openingMessage: "Thanks for your comment! I have it ready for you.",
  confirmationButtonLabel: "Send it",
  emailCaptureEnabled: false,
  emailPromptMessage: "What’s the best email address to send this to?",
  emailMarketingConsentEnabled: false,
  followGateEnabled: false,
  followPromptMessage: "Follow this account, then tap I’ve followed.",
  followMaxRechecks: 3,
  followFailAction: "send_anyway",
  replyButtonLabel: "",
  replyButtonUrl: "",
  enabled: true,
};

function basicInstagramDraft(draft: Draft): Draft {
  return {
    ...draft,
    excludedKeywords: "",
    publicReplyEnabled: false,
    publicReplyMessages: "",
    openingMessage: "",
    confirmationButtonLabel: "",
    emailCaptureEnabled: false,
    emailPromptMessage: "",
    emailMarketingConsentEnabled: false,
    followGateEnabled: false,
  };
}

const INSTAGRAM_ONBOARDING_DISMISSED_KEY = "bento:instagram-auto-dm-onboarding-dismissed:v1";

function InstagramAutoDmPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["instagram-auto-dm"],
    queryFn: () => getInstagramAutoDmDashboard(),
    refetchInterval: 30_000,
  });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [onboardingPreferenceLoaded, setOnboardingPreferenceLoaded] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] =
    useState<InstagramAutoDmStarterTemplateId | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const updateDraft = (next: Draft) =>
    setDraft(data?.advancedAutoDm ? next : basicInstagramDraft(next));

  useEffect(() => {
    setOnboardingDismissed(
      window.localStorage.getItem(INSTAGRAM_ONBOARDING_DISMISSED_KEY) === "true",
    );
    setOnboardingPreferenceLoaded(true);
  }, []);

  const connections = data?.connections || [];
  const readyConnections = connections.filter((connection) => connection.ready);
  const sentCount = (data?.activity || []).filter(
    (event: InstagramDmActivity) => event.status === "sent",
  ).length;
  const activeCount = (data?.automations || []).filter(
    (automation: InstagramDmAutomation) => automation.enabled,
  ).length;
  const setTab = (nextTab: (typeof instagramAutoDmTabs)[number]["id"]) =>
    void navigate({
      to: "/auto-dms/instagram",
      search: { tab: nextTab },
      replace: true,
    });

  const save = useMutation({
    mutationFn: () =>
      saveInstagramAutoDmAutomation({
        data: {
          id: draft.id,
          connectionId: draft.connectionId,
          name: draft.name,
          triggerType: draft.triggerType,
          keywords: splitList(draft.keywords),
          excludedKeywords: data?.advancedAutoDm ? splitList(draft.excludedKeywords) : [],
          matchType: draft.matchType,
          mediaScope: draft.mediaScope,
          mediaIds: draft.mediaIds,
          replyMessage: draft.replyMessage,
          publicReplyEnabled: Boolean(data?.advancedAutoDm && draft.publicReplyEnabled),
          publicReplyMessages:
            data?.advancedAutoDm && draft.publicReplyEnabled
              ? splitLines(draft.publicReplyMessages)
              : [],
          openingMessage:
            data?.advancedAutoDm && triggerFamily(draft.triggerType) === "comment"
              ? draft.openingMessage.trim() || null
              : null,
          confirmationButtonLabel:
            data?.advancedAutoDm && triggerFamily(draft.triggerType) === "comment"
              ? draft.confirmationButtonLabel.trim() || null
              : null,
          emailCaptureEnabled: Boolean(
            data?.advancedAutoDm &&
            triggerFamily(draft.triggerType) === "comment" &&
            draft.emailCaptureEnabled,
          ),
          emailPromptMessage:
            data?.advancedAutoDm &&
            triggerFamily(draft.triggerType) === "comment" &&
            draft.emailCaptureEnabled
              ? draft.emailPromptMessage.trim() || null
              : null,
          emailMarketingConsentEnabled:
            Boolean(data?.advancedAutoDm) &&
            triggerFamily(draft.triggerType) === "comment" &&
            draft.emailCaptureEnabled &&
            draft.emailMarketingConsentEnabled,
          followGateEnabled: Boolean(
            data?.advancedAutoDm &&
            triggerFamily(draft.triggerType) === "comment" &&
            draft.followGateEnabled,
          ),
          followPromptMessage: draft.followPromptMessage,
          followMaxRechecks: draft.followMaxRechecks,
          followFailAction: draft.followFailAction,
          replyButtonLabel: draft.replyButtonLabel.trim() || null,
          replyButtonUrl: draft.replyButtonUrl.trim() || null,
          enabled: draft.enabled,
        },
      }),
    onSuccess: (next) => {
      const createdFirstAutomation = !draft.id && (data?.automations.length || 0) === 0;
      queryClient.setQueryData(["instagram-auto-dm"], next);
      setEditorOpen(false);
      setDraft({ ...EMPTY_DRAFT, connectionId: readyConnections[0]?.id || "" });
      setSelectedTemplateId(null);
      if (createdFirstAutomation) setOnboardingCompleted(true);
      toast.success(draft.id ? "Automation updated" : "Auto-DM is ready");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save this automation"),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setInstagramAutoDmEnabled({ data: { id, enabled } }),
    onSuccess: (next) => queryClient.setQueryData(["instagram-auto-dm"], next),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update this automation"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteInstagramAutoDmAutomation({ data: { id } }),
    onSuccess: (next) => {
      queryClient.setQueryData(["instagram-auto-dm"], next);
      toast.success("Automation deleted");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not delete this automation"),
  });

  const preflight = useMutation({
    mutationFn: (id: string) => preflightInstagramAutoDmAutomation({ data: { id } }),
    onSuccess: (result) => {
      queryClient.setQueryData(["instagram-auto-dm"], result.dashboard);
      toast.success("Official Meta preflight passed");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Instagram preflight failed"),
  });

  const subscribe = useMutation({
    mutationFn: (connectionId: string) => enableInstagramAutoDmWebhooks({ data: { connectionId } }),
    onSuccess: (next) => {
      queryClient.setQueryData(["instagram-auto-dm"], next);
      toast.success("Instagram webhooks enabled");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not enable Instagram webhooks"),
  });

  useWebMcpTools(
    createAutoDmWebMcpTools({
      platform: "instagram",
      loadDashboard: () => getInstagramAutoDmDashboard(),
      getMedia: (connectionId) => getInstagramAutoDmMedia({ data: { connectionId } }),
      preflight: (automationId) =>
        preflightInstagramAutoDmAutomation({ data: { id: automationId } }),
      repairConnection: (connectionId) => enableInstagramAutoDmWebhooks({ data: { connectionId } }),
      onDashboard: (next) => queryClient.setQueryData(["instagram-auto-dm"], next),
    }),
  );

  function openNew() {
    updateDraft({
      ...EMPTY_DRAFT,
      connectionId: readyConnections[0]?.id || connections[0]?.id || "",
    });
    setEditorOpen(true);
  }

  function chooseStarterTemplate(templateId: InstagramAutoDmStarterTemplateId) {
    const template = getInstagramAutoDmStarterTemplate(templateId);
    setSelectedTemplateId(templateId);
    updateDraft({
      ...template.draft,
      mediaIds: [...template.draft.mediaIds],
      connectionId: readyConnections[0]?.id || connections[0]?.id || "",
    });
    setEditorOpen(true);
  }

  function skipOnboarding() {
    window.localStorage.setItem(INSTAGRAM_ONBOARDING_DISMISSED_KEY, "true");
    setOnboardingDismissed(true);
    setSelectedTemplateId(null);
    setEditorOpen(false);
  }

  function reopenOnboarding() {
    window.localStorage.removeItem(INSTAGRAM_ONBOARDING_DISMISSED_KEY);
    setOnboardingDismissed(false);
    setOnboardingCompleted(false);
    setSelectedTemplateId(null);
    setEditorOpen(false);
  }

  function edit(automation: InstagramDmAutomation) {
    updateDraft({
      id: automation.id,
      connectionId: automation.connectionId,
      name: automation.name,
      triggerType: automation.triggerType,
      keywords: automation.keywords.join(", "),
      excludedKeywords: automation.excludedKeywords.join(", "),
      matchType: automation.matchType,
      mediaScope: automation.mediaScope,
      mediaIds: automation.mediaIds,
      replyMessage: automation.replyMessage,
      publicReplyEnabled: automation.publicReplyEnabled,
      publicReplyMessages: [
        ...automation.publicReplyMessages,
        ...splitLines(DEFAULT_PUBLIC_REPLY_MESSAGES).slice(automation.publicReplyMessages.length),
      ]
        .slice(0, 3)
        .join("\n"),
      openingMessage: automation.openingMessage || "",
      confirmationButtonLabel: automation.confirmationButtonLabel || "",
      emailCaptureEnabled: automation.emailCaptureEnabled,
      emailPromptMessage:
        automation.emailPromptMessage || "What’s the best email address to send this to?",
      emailMarketingConsentEnabled: automation.emailMarketingConsentEnabled,
      followGateEnabled: automation.followGateEnabled,
      followPromptMessage: automation.followPromptMessage,
      followMaxRechecks: automation.followMaxRechecks,
      followFailAction: automation.followFailAction,
      replyButtonLabel: automation.replyButtonLabel || "",
      replyButtonUrl: automation.replyButtonUrl || "",
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
        title="Instagram Auto-DM"
        actions={
          !data?.locked && !showOnboarding && !onboardingCompleted ? (
            connections.length ? (
              <button type="button" onClick={openNew} className={micro.btnPrimaryCompact}>
                <Sparkles className="size-4" /> New Auto-DM
              </button>
            ) : (
              <SettingsIntegrationsLink integration="automation" compact>
                Connect Instagram
              </SettingsIntegrationsLink>
            )
          ) : undefined
        }
      />

      <div className={micro.main}>
        <DmAutomationPlatformNav current="instagram" />
        {!isLoading && !data?.advancedAutoDm && (
          <div
            className={`${micro.bannerInfo} mb-6 flex flex-wrap items-center justify-between gap-3`}
          >
            <p className="text-sm">
              Free includes unlimited Trigger → message/link automations. Store unlocks follow
              checks, email capture, public replies and multi-step flows.
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
              <StatCard
                icon={Instagram}
                label="Connected accounts"
                value={readyConnections.length}
              />
            </div>
          )}

        {isLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <LoaderCircle className="size-8 animate-spin text-primary" />
          </div>
        ) : data?.locked ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <MicroAppPanel className="text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[#ffd6e6]/70">
                <Mail className="size-6" />
              </div>
              <h2 className="mt-5 font-ui-display text-3xl">Turn comments into conversations</h2>
              <p className={`mx-auto mt-2 max-w-lg ${micro.muted}`}>
                Instagram Auto DMs are included with every Bento plan.
              </p>
              <div className="mt-6 flex justify-center">
                <UpgradeDialog feature="instagramAutoDM" />
              </div>
            </MicroAppPanel>
            {(data.automations || []).length > 0 && (
              <MicroAppPanel>
                <p className={micro.eyebrowMuted}>Existing automations</p>
                <h2 className="mt-1 font-ui-display text-2xl">Your data is still here</h2>
                <div className="mt-5 space-y-3">
                  {data.automations.map((automation: InstagramDmAutomation) => (
                    <div
                      key={automation.id}
                      className={`flex items-center justify-between gap-4 px-4 py-3 ${micro.soft}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{automation.name}</p>
                        <p className="text-xs text-muted-foreground">
                          @{automation.connectionHandle} ·{" "}
                          {automation.enabled ? "Paused on Free" : "Off"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {automation.enabled && (
                          <button
                            type="button"
                            onClick={() => toggle.mutate({ id: automation.id, enabled: false })}
                            disabled={toggle.isPending}
                            className={micro.btnOutline}
                          >
                            Turn off
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Delete ${automation.name}`}
                          onClick={() => {
                            if (window.confirm(`Delete “${automation.name}”?`)) {
                              remove.mutate(automation.id);
                            }
                          }}
                          disabled={remove.isPending}
                          className="inline-flex size-9 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-500/10"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </MicroAppPanel>
            )}
          </div>
        ) : isError ? (
          <MicroAppPanel>
            <p className="text-sm text-rose-600">
              Instagram Auto-DM could not load. Please refresh and try again.
            </p>
          </MicroAppPanel>
        ) : showOnboarding ? (
          <InstagramAutoDmOnboarding
            connections={connections}
            selectedTemplateId={selectedTemplateId}
            draft={draft}
            setDraft={updateDraft}
            saving={save.isPending}
            repairing={subscribe.isPending}
            configured={Boolean(data?.configured)}
            generalCustomerAccess={Boolean(data?.generalCustomerAccess)}
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
          <FirstAutomationSuccess
            automationName={data?.automations[0]?.name || "Your first Auto-DM"}
            onContinue={() => setOnboardingCompleted(false)}
          />
        ) : (
          <div className="space-y-6">
            {!data?.generalCustomerAccess && (
              <div role="status" className={micro.bannerWarn}>
                <span className="font-semibold">Meta review is still in progress.</span> Instagram's
                official API currently accepts accounts assigned to Bento's Meta app as
                administrators, developers, or testers. General customer accounts become available
                after Meta grants Advanced Access.
              </div>
            )}
            <MicroAppTabs
              tabs={instagramAutoDmTabs.map((item) => ({
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
                        Turn comments into conversations.
                      </h2>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                        Reply when someone comments, sends a DM, replies to a Story, comments on a
                        Live, or shares your post or reel.
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
                      data?.automations.map((automation: InstagramDmAutomation) => (
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
                          Connect Instagram in Settings, then create your first keyword reply.
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
                            icon={<SiInstagram className="size-3.5" />}
                          >
                            Connect Instagram
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
                        void queryClient.invalidateQueries({ queryKey: ["instagram-auto-dm"] })
                      }
                      className={`${micro.btnSoft} size-10 px-0`}
                      aria-label="Refresh activity"
                    >
                      <RefreshCw className="size-4" />
                    </button>
                  </div>
                  <div className="mt-5 divide-y divide-border/65">
                    {(data?.activity || []).length ? (
                      data?.activity.map((event: InstagramDmActivity) => (
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
                  <div className="mt-7 border-t border-border/65 pt-5">
                    <p className={micro.eyebrowMuted}>Workflow runs</p>
                    <div className="mt-3 divide-y divide-border/65">
                      {(data?.workflows || []).length ? (
                        data?.workflows
                          .slice(0, 10)
                          .map((workflow: InstagramDmWorkflow) => (
                            <WorkflowRow key={workflow.id} workflow={workflow} />
                          ))
                      ) : (
                        <p
                          className={`${micro.soft} px-5 py-6 text-center text-sm text-muted-foreground`}
                        >
                          Confirmation and email-capture runs will appear here.
                        </p>
                      )}
                    </div>
                  </div>
                </MicroAppPanel>
              ) : (
                <div className="mx-auto w-full max-w-3xl">
                  <MicroAppPanel>
                    <div className="flex size-14 items-center justify-center rounded-[20px] bg-gradient-to-br from-[#feda75] via-[#d62976] to-[#4f5bd5] text-white shadow-lg shadow-pink-500/20">
                      <SiInstagram className="size-7" />
                    </div>
                    <p className={`mt-5 ${micro.eyebrowMuted}`}>Instagram connection</p>
                    <h2 className="mt-1 font-ui-display text-2xl">
                      Official API. No pasted passwords.
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Auto-DM works with Instagram professional accounts. Reconnect once to approve
                      comment and message access.
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
                                  <>Webhook verification required</>
                                )}
                              </div>
                              {!connection.ready &&
                                (connection.readinessMessage || connection.lastError) && (
                                  <p className="mt-1 text-xs leading-4 text-rose-600 dark:text-rose-300">
                                    {connection.readinessMessage || connection.lastError}
                                  </p>
                                )}
                            </div>
                            <div className="flex w-full items-center gap-1 min-[420px]:w-auto">
                              {!connection.needsReconnect && (
                                <button
                                  type="button"
                                  onClick={() => subscribe.mutate(connection.id)}
                                  disabled={subscribe.isPending}
                                  className={`${micro.btnSoft} flex-1 rounded-xl px-3 py-2 text-xs min-[420px]:flex-none`}
                                >
                                  {connection.ready ? "Recheck" : "Repair"}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      <SettingsIntegrationsLink
                        integration="automation"
                        className={`${micro.btnInk} w-full`}
                        icon={<SiInstagram className="size-4" />}
                      >
                        {connections.some((connection) => connection.needsReconnect)
                          ? "Reconnect Instagram"
                          : connections.length
                            ? "Connect another account"
                            : "Connect Instagram"}
                      </SettingsIntegrationsLink>
                    </div>

                    {!data?.configured && (
                      <div className="mt-5 rounded-2xl bg-amber-500/10 p-4 text-xs leading-5 text-amber-800 dark:text-amber-200">
                        Instagram Auto-DM still needs its server webhook configuration before
                        replies can go live.
                      </div>
                    )}
                    <div className={`${micro.soft} mt-5 p-4 text-xs leading-5 text-[#17213a]/70`}>
                      Bento uses Meta's official API and the queue already powering your account.
                      There is no paid Auto-DM add-on. Meta's messaging window and
                      one-reply-per-comment rules still apply.
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

type InstagramOnboardingConnection = {
  id: string;
  handle: string;
  ready: boolean;
  needsReconnect: boolean;
  readinessMessage?: string | null;
  lastError?: string | null;
};

function InstagramAutoDmOnboarding({
  connections,
  selectedTemplateId,
  draft,
  setDraft,
  saving,
  repairing,
  configured,
  generalCustomerAccess,
  onChooseTemplate,
  onBackToTemplates,
  onRepair,
  onSave,
  onSkip,
}: {
  connections: InstagramOnboardingConnection[];
  selectedTemplateId: InstagramAutoDmStarterTemplateId | null;
  draft: Draft;
  setDraft: (draft: Draft) => void;
  saving: boolean;
  repairing: boolean;
  configured: boolean;
  generalCustomerAccess: boolean;
  onChooseTemplate: (templateId: InstagramAutoDmStarterTemplateId) => void;
  onBackToTemplates: () => void;
  onRepair: (connectionId: string) => void;
  onSave: () => void;
  onSkip: () => void;
}) {
  const readyConnection = connections.find((connection) => connection.ready);
  const currentStep = getInstagramAutoDmOnboardingStep({
    hasReadyConnection: Boolean(readyConnection),
    selectedTemplateId,
  });
  const currentStepIndex = currentStep === "connect" ? 0 : currentStep === "template" ? 1 : 2;
  const steps = ["Connect Instagram", "Choose a starter", "Make it yours"];

  return (
    <div className="mx-auto max-w-6xl">
      <MicroAppPanel className="overflow-hidden" padded={false}>
        <div className="border-b border-border/65 px-5 py-5 sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#feda75] via-[#d62976] to-[#4f5bd5] text-white shadow-lg shadow-pink-500/15">
                <SiInstagram className="size-5" />
              </div>
              <div>
                <p className={micro.eyebrowMuted}>First Auto-DM</p>
                <h1 className="font-ui-display text-2xl sm:text-3xl">
                  Start one real conversation
                </h1>
              </div>
            </div>
            <button
              type="button"
              onClick={onSkip}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" /> <span className="hidden sm:inline">Skip for now</span>
            </button>
          </div>

          <div
            className="mt-5 grid grid-cols-3 gap-2"
            aria-label={`Step ${currentStepIndex + 1} of 3`}
          >
            {steps.map((label, index) => (
              <div key={label}>
                <div
                  className={`h-1.5 rounded-full transition-colors ${index <= currentStepIndex ? "bg-primary" : "bg-border"}`}
                />
                <p
                  className={`mt-2 hidden text-[11px] font-semibold sm:block ${index === currentStepIndex ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {index + 1}. {label}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="p-5 sm:p-7">
          {currentStep === "connect" && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)] lg:items-stretch">
              <div className="rounded-[26px] border border-border/70 bg-background/70 p-5 sm:p-7">
                <span className="inline-flex rounded-full bg-[#dceaff] px-3 py-1 text-[11px] font-semibold text-[#3478f6]">
                  Step 1 of 3
                </span>
                <h2 className="mt-4 font-ui-display text-3xl sm:text-4xl">
                  Connect the account you want Bento to reply from.
                </h2>
                <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                  Bento uses Meta’s official login. We never ask for or store your Instagram
                  password. Professional creator and business accounts are supported.
                </p>

                {connections.length > 0 && (
                  <div className="mt-6 space-y-3">
                    {connections.map((connection) => (
                      <div
                        key={connection.id}
                        className="rounded-2xl border border-border/70 bg-card p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">@{connection.handle}</p>
                            <p className="mt-1 text-xs leading-5 text-rose-600 dark:text-rose-300">
                              {connection.readinessMessage ||
                                connection.lastError ||
                                (connection.needsReconnect
                                  ? "Reconnect to approve the required Meta permissions."
                                  : "Complete webhook verification to make this account ready.")}
                            </p>
                          </div>
                          {!connection.needsReconnect && (
                            <button
                              type="button"
                              onClick={() => onRepair(connection.id)}
                              disabled={repairing}
                              className={`${micro.btnSoft} shrink-0 rounded-xl px-4 py-2.5 text-xs`}
                            >
                              {repairing ? (
                                <LoaderCircle className="size-3.5 animate-spin" />
                              ) : (
                                <RefreshCw className="size-3.5" />
                              )}
                              Repair connection
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-6 max-w-sm">
                  <SettingsIntegrationsLink
                    integration="automation"
                    className={`${micro.btnInk} w-full`}
                    icon={<SiInstagram className="size-4" />}
                  >
                    {connections.some((connection) => connection.needsReconnect)
                      ? "Reconnect Instagram"
                      : connections.length
                        ? "Connect another account"
                        : "Connect Instagram"}
                  </SettingsIntegrationsLink>
                </div>

                {!configured && (
                  <p className="mt-4 rounded-2xl bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                    Bento’s Instagram webhook is not configured yet. You can connect an account, but
                    an automation cannot go live until the server setup is complete.
                  </p>
                )}
                {!generalCustomerAccess && (
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                    While Meta’s review is in progress, only accounts assigned to Bento’s Meta app
                    can finish this connection.
                  </p>
                )}
              </div>

              <AutomationConversationPreview
                title="What you are setting up"
                trigger="Someone engages with your Instagram"
                opening="Bento checks your rule instantly"
                reply="A helpful reply is sent from your account"
              />
            </div>
          )}

          {currentStep === "template" && (
            <div>
              <div className="max-w-2xl">
                <span className="inline-flex rounded-full bg-[#e7f7ee] px-3 py-1 text-[11px] font-semibold text-[#197a4d]">
                  @{readyConnection?.handle} is ready
                </span>
                <h2 className="mt-4 font-ui-display text-3xl sm:text-4xl">
                  What should your first automation do?
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Pick a proven starting point. You will review every word and setting before it
                  goes live.
                </p>
              </div>

              <div className="mt-7 grid gap-4 lg:grid-cols-3">
                {INSTAGRAM_AUTO_DM_STARTER_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => onChooseTemplate(template.id)}
                    className="group flex min-h-64 flex-col rounded-[26px] border border-border/70 bg-background/70 p-5 text-left transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className={`${micro.iconWell} size-12 text-xl`}>{template.emoji}</span>
                      <span
                        className={`${micro.soft} rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground`}
                      >
                        {template.eyebrow}
                      </span>
                    </div>
                    <h3 className="mt-5 font-sans text-lg font-semibold">{template.name}</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {template.description}
                    </p>
                    <div className="mt-auto flex items-center justify-between gap-3 pt-5 text-xs font-semibold text-primary">
                      Use this starter{" "}
                      <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {currentStep === "customize" && (
            <div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <span className="inline-flex rounded-full bg-[#ece7ff] px-3 py-1 text-[11px] font-semibold text-[#5b4bc9]">
                    Final step
                  </span>
                  <h2 className="mt-3 font-ui-display text-3xl sm:text-4xl">
                    Review it, then turn it on.
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Your chosen starter is already filled in. Adjust anything you want before
                    launch.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onBackToTemplates}
                  className={`${micro.btnSoft} self-start rounded-xl px-4 py-2.5 text-xs sm:self-auto`}
                >
                  Choose another starter
                </button>
              </div>
              <AutomationEditor
                key={selectedTemplateId}
                draft={draft}
                setDraft={setDraft}
                connections={connections}
                saving={saving}
                onCancel={onBackToTemplates}
                onSave={onSave}
              />
            </div>
          )}
        </div>
      </MicroAppPanel>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        You can connect more accounts and create advanced rules after this setup.
      </p>
    </div>
  );
}

function AutomationConversationPreview({
  title,
  trigger,
  opening,
  reply,
}: {
  title: string;
  trigger: string;
  opening: string;
  reply: string;
}) {
  return (
    <div className="flex min-h-[28rem] flex-col rounded-[26px] bg-gradient-to-br from-[#feda75]/45 via-[#ffd6e6]/60 to-[#4f5bd5]/20 p-5 sm:p-7">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/55">
        {title}
      </p>
      <div className="my-auto rounded-[26px] border border-white/70 bg-card/90 p-4 shadow-xl shadow-slate-900/10 backdrop-blur-xl">
        <div className="flex items-center gap-3 border-b border-border/60 pb-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-gradient-to-br from-[#feda75] via-[#d62976] to-[#4f5bd5] text-white">
            <SiInstagram className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">Instagram conversation</p>
            <p className="text-[11px] text-muted-foreground">Powered by Meta’s official API</p>
          </div>
        </div>
        <div className="mt-4 space-y-3 text-sm">
          <div className="mr-8 rounded-2xl rounded-tl-md bg-accent px-4 py-3">{trigger}</div>
          <div className="ml-8 rounded-2xl rounded-tr-md bg-primary/12 px-4 py-3 text-foreground">
            {opening}
          </div>
          <div className="ml-8 rounded-2xl rounded-tr-md bg-primary px-4 py-3 text-primary-foreground">
            {reply}
          </div>
        </div>
      </div>
      <p className="text-xs leading-5 text-foreground/60">
        You stay in control. Pause, edit, test, or delete any automation later.
      </p>
    </div>
  );
}

function FirstAutomationSuccess({
  automationName,
  onContinue,
}: {
  automationName: string;
  onContinue: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <MicroAppPanel className="text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-[22px] bg-emerald-500/12 text-emerald-600">
          <CheckCircle2 className="size-8" />
        </div>
        <p className={`mt-5 ${micro.eyebrowMuted}`}>Setup complete</p>
        <h2 className="mt-2 font-ui-display text-4xl">Your first Auto-DM is ready.</h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          “{automationName}” has been saved. When its trigger matches, Bento will handle the reply
          through Meta’s official Instagram API.
        </p>
        <button type="button" onClick={onContinue} className={`${micro.btnInk} mt-7`}>
          View my automations <ArrowRight className="size-4" />
        </button>
      </MicroAppPanel>
    </div>
  );
}

type TriggerFamily = "comment" | "dm" | "story" | "live" | "share";

const TRIGGER_FAMILIES: Array<{
  id: TriggerFamily;
  label: string;
  icon: ReactNode;
  tint: string;
}> = [
  {
    id: "comment",
    label: "Comments on your post or reel",
    icon: <MessageCircleReply className="size-4" />,
    tint: "bg-[#e7f7ee] text-[#197a4d]",
  },
  {
    id: "dm",
    label: "Sends you a DM",
    icon: <MessagesSquare className="size-4" />,
    tint: "bg-[#dceaff] text-[#3478f6]",
  },
  {
    id: "story",
    label: "Replies to your story",
    icon: <SiInstagram className="size-4" />,
    tint: "bg-[#ffd6e6]/70 dark:bg-[#b72d64]/20",
  },
  {
    id: "live",
    label: "Comments on your Live",
    icon: <Radio className="size-4" />,
    tint: "bg-rose-500/10 text-rose-600",
  },
  {
    id: "share",
    label: "Shares your post or reel in a DM",
    icon: <Share2 className="size-4" />,
    tint: "bg-amber-500/10 text-amber-700",
  },
];

function triggerFamily(trigger: InstagramDmTriggerType): TriggerFamily {
  if (trigger === "comment_keyword" || trigger === "any_comment") return "comment";
  if (trigger === "dm_keyword" || trigger === "any_dm") return "dm";
  if (trigger === "story_reply_keyword" || trigger === "any_story_reply") return "story";
  if (trigger === "live_comment_keyword" || trigger === "any_live_comment") return "live";
  return "share";
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
  const [step, setStep] = useState(1);
  const family = triggerFamily(draft.triggerType);
  const needsKeywords = ![
    "any_comment",
    "any_dm",
    "any_story_reply",
    "any_live_comment",
    "post_share",
  ].includes(draft.triggerType);
  const isComment = family === "comment" || family === "live";
  const supportsSuggestedReply = family === "comment";
  const supportsMedia = isComment || family === "share";
  const { data: media = [], isLoading: mediaLoading } = useQuery({
    queryKey: ["instagram-auto-dm-media", draft.connectionId],
    queryFn: () => getInstagramAutoDmMedia({ data: { connectionId: draft.connectionId } }),
    enabled: Boolean(draft.connectionId) && supportsMedia,
    staleTime: 5 * 60_000,
  });
  const currentMediaRefs = useMemo(
    () => media.flatMap((item) => [family === "share" ? item.permalink : item.id]),
    [family, media],
  );
  useEffect(() => {
    if (draft.mediaScope === "future" && currentMediaRefs.length > 0) {
      setDraft({ ...draft, mediaIds: currentMediaRefs });
    }
    // Only refresh the future-post baseline when the selected account or loaded
    // media changes. Including the whole draft would make this loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.connectionId, draft.mediaScope, currentMediaRefs.join("|")]);

  const validUrl =
    !draft.replyButtonUrl.trim() ||
    (() => {
      try {
        return new URL(draft.replyButtonUrl).protocol === "https:";
      } catch {
        return false;
      }
    })();
  const canSave =
    draft.connectionId &&
    draft.name.trim() &&
    draft.replyMessage.trim() &&
    (!needsKeywords || splitList(draft.keywords).length > 0) &&
    (!draft.publicReplyEnabled || splitLines(draft.publicReplyMessages).length > 0) &&
    (draft.mediaScope !== "specific" || draft.mediaIds.length > 0) &&
    (!supportsSuggestedReply ||
      Boolean(draft.openingMessage.trim()) === Boolean(draft.confirmationButtonLabel.trim())) &&
    (!supportsSuggestedReply ||
      !draft.emailCaptureEnabled ||
      (Boolean(draft.openingMessage.trim()) &&
        Boolean(draft.confirmationButtonLabel.trim()) &&
        Boolean(draft.emailPromptMessage.trim()))) &&
    (!supportsSuggestedReply ||
      !draft.followGateEnabled ||
      Boolean(draft.followPromptMessage.trim())) &&
    Boolean(draft.replyButtonLabel.trim()) === Boolean(draft.replyButtonUrl.trim()) &&
    validUrl;

  const stepValid =
    step === 1
      ? Boolean(draft.connectionId) &&
        (draft.mediaScope !== "specific" || draft.mediaIds.length > 0)
      : step === 2
        ? (!needsKeywords || splitList(draft.keywords).length > 0) &&
          (!draft.publicReplyEnabled || splitLines(draft.publicReplyMessages).length > 0)
        : canSave;

  function selectFamily(nextFamily: TriggerFamily) {
    const triggerType: InstagramDmTriggerType =
      nextFamily === "comment"
        ? "comment_keyword"
        : nextFamily === "dm"
          ? "dm_keyword"
          : nextFamily === "story"
            ? "story_reply_keyword"
            : nextFamily === "live"
              ? "live_comment_keyword"
              : "post_share";
    setDraft({
      ...draft,
      triggerType,
      mediaScope: nextFamily === "dm" || nextFamily === "story" ? "any" : draft.mediaScope,
      mediaIds: [],
      publicReplyEnabled:
        nextFamily === "comment" || nextFamily === "live" ? draft.publicReplyEnabled : false,
      openingMessage: nextFamily === "comment" ? draft.openingMessage : "",
      confirmationButtonLabel: nextFamily === "comment" ? draft.confirmationButtonLabel : "",
      emailCaptureEnabled: nextFamily === "comment" ? draft.emailCaptureEnabled : false,
      emailMarketingConsentEnabled:
        nextFamily === "comment" ? draft.emailMarketingConsentEnabled : false,
      followGateEnabled: nextFamily === "comment" ? draft.followGateEnabled : false,
    });
  }

  function setKeywordMode(any: boolean) {
    const triggerType: InstagramDmTriggerType =
      family === "comment"
        ? any
          ? "any_comment"
          : "comment_keyword"
        : family === "dm"
          ? any
            ? "any_dm"
            : "dm_keyword"
          : family === "story"
            ? any
              ? "any_story_reply"
              : "story_reply_keyword"
            : family === "live"
              ? any
                ? "any_live_comment"
                : "live_comment_keyword"
              : "post_share";
    setDraft({ ...draft, triggerType });
  }

  function toggleMedia(reference: string) {
    setDraft({
      ...draft,
      mediaIds: draft.mediaIds.includes(reference)
        ? draft.mediaIds.filter((item) => item !== reference)
        : [...draft.mediaIds, reference],
    });
  }

  return (
    <div className="mt-6 overflow-hidden rounded-[28px] border border-border/70 bg-background/75 shadow-sm">
      <div className="border-b border-border/65 px-4 py-4 sm:px-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className={micro.eyebrowMuted}>Step {step} of 3</p>
            <h3 className="mt-1 font-ui-display text-2xl">
              {step === 1 ? "Choose the moment" : step === 2 ? "Set the trigger" : "Write the DM"}
            </h3>
          </div>
          <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((item) => (
              <span
                key={item}
                className={`h-2 rounded-full transition-all ${item === step ? "w-8 bg-primary" : item < step ? "w-2 bg-primary/55" : "w-2 bg-border"}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="p-4 sm:p-6">
        {step === 1 && (
          <div className="space-y-5">
            <Field label="Instagram account" hint="Switch any time">
              <div className="relative">
                <select
                  value={draft.connectionId}
                  onChange={(event) =>
                    setDraft({ ...draft, connectionId: event.target.value, mediaIds: [] })
                  }
                  className={`${inputClass} appearance-none pr-10`}
                >
                  <option value="">Choose account</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      @{connection.handle}
                      {connection.ready ? "" : " - reconnect required"}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-3.5 size-4 text-muted-foreground" />
              </div>
            </Field>

            <div>
              <p className={`mb-2 ${micro.eyebrowMuted}`}>Trigger Auto-DM when someone…</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {TRIGGER_FAMILIES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => selectFamily(option.id)}
                    className={`flex min-h-16 items-center gap-3 rounded-2xl border p-3 text-left transition ${family === option.id ? "border-primary bg-primary/8 ring-2 ring-primary/10" : "border-border/70 bg-card hover:bg-accent/55"}`}
                  >
                    <span
                      className={`flex size-10 shrink-0 items-center justify-center rounded-[14px] ${option.tint}`}
                    >
                      {option.icon}
                    </span>
                    <span className="text-sm font-semibold leading-5">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {supportsMedia && (
              <div className="space-y-3">
                <div className={`${micro.soft} grid grid-cols-3 gap-2 rounded-2xl p-1`}>
                  {(["specific", "any", "future"] as const).map((mediaScope) => (
                    <button
                      key={mediaScope}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          mediaScope,
                          mediaIds: mediaScope === "future" ? currentMediaRefs : [],
                        })
                      }
                      className={`rounded-xl px-2 py-2 text-xs font-semibold capitalize transition ${draft.mediaScope === mediaScope ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                    >
                      {mediaScope === "specific"
                        ? "Specific posts"
                        : mediaScope === "any"
                          ? "Any post"
                          : "Future posts"}
                    </button>
                  ))}
                </div>
                {draft.mediaScope === "specific" && (
                  <div>
                    {mediaLoading ? (
                      <div className={`${micro.soft} flex h-36 items-center justify-center`}>
                        <LoaderCircle className="size-5 animate-spin" />
                      </div>
                    ) : media.length ? (
                      <div
                        className={`${micro.soft} grid max-h-80 grid-cols-3 gap-2 overflow-y-auto p-2 sm:grid-cols-4`}
                      >
                        {media.map((item) => {
                          const reference = family === "share" ? item.permalink : item.id;
                          const selected = draft.mediaIds.includes(reference);
                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => toggleMedia(reference)}
                              aria-label={`${selected ? "Unselect" : "Select"} ${item.caption}`}
                              className={`relative aspect-square overflow-hidden rounded-xl bg-card ring-offset-2 transition ${selected ? "ring-2 ring-primary" : "ring-1 ring-border/60"}`}
                            >
                              {item.imageUrl ? (
                                <DecodedImage
                                  src={item.imageUrl}
                                  alt=""
                                  loading="lazy"
                                  className="size-full object-cover"
                                />
                              ) : (
                                <span className="flex size-full items-center justify-center bg-gradient-to-br from-[#feda75]/45 via-[#d62976]/30 to-[#4f5bd5]/35">
                                  <SquarePlay className="size-5" />
                                </span>
                              )}
                              {selected && (
                                <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                  <CheckCircle2 className="size-3.5" />
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rounded-2xl bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200">
                        No posts were returned for this account. Choose “Any post” or reconnect it.
                      </p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {draft.mediaIds.length} selected
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            {family !== "share" && (
              <div className={`${micro.soft} grid grid-cols-2 gap-2 rounded-2xl p-1`}>
                <button
                  type="button"
                  onClick={() => setKeywordMode(false)}
                  className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${needsKeywords ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                >
                  Specific keywords
                </button>
                <button
                  type="button"
                  onClick={() => setKeywordMode(true)}
                  className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${!needsKeywords ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                >
                  Any {family === "story" ? "reply" : family === "dm" ? "DM" : "comment"}
                </button>
              </div>
            )}
            {needsKeywords && (
              <>
                <Field label="Include these keywords" hint="Comma separated">
                  <input
                    value={draft.keywords}
                    maxLength={800}
                    onChange={(event) => setDraft({ ...draft, keywords: event.target.value })}
                    className={inputClass}
                    placeholder="link, guide, price"
                  />
                </Field>
                <Field label="Exclude these keywords" hint="Optional">
                  <input
                    value={draft.excludedKeywords}
                    maxLength={800}
                    onChange={(event) =>
                      setDraft({ ...draft, excludedKeywords: event.target.value })
                    }
                    className={inputClass}
                    placeholder="spam, scam"
                  />
                </Field>
                <Field label="Match style">
                  <div className={`${micro.soft} grid grid-cols-2 gap-2 rounded-2xl p-1`}>
                    {(["contains", "exact"] as const).map((matchType) => (
                      <button
                        key={matchType}
                        type="button"
                        onClick={() => setDraft({ ...draft, matchType })}
                        className={`rounded-xl px-3 py-2 text-sm font-semibold capitalize transition ${draft.matchType === matchType ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                      >
                        {matchType}
                      </button>
                    ))}
                  </div>
                </Field>
              </>
            )}

            {isComment && (
              <div className={`${micro.soft} p-4`}>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold">Reply publicly too</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Add up to 3 replies. Bento rotates them naturally.
                    </div>
                  </div>
                  <Switch
                    checked={draft.publicReplyEnabled}
                    onCheckedChange={(publicReplyEnabled) =>
                      setDraft({
                        ...draft,
                        publicReplyEnabled,
                        publicReplyMessages:
                          publicReplyEnabled && !splitLines(draft.publicReplyMessages).length
                            ? DEFAULT_PUBLIC_REPLY_MESSAGES
                            : draft.publicReplyMessages,
                      })
                    }
                  />
                </div>
                {draft.publicReplyEnabled && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    {publicReplyFields(draft.publicReplyMessages).map((reply, index) => (
                      <Field key={index} label={`Public reply ${index + 1}`}>
                        <input
                          value={reply}
                          maxLength={300}
                          onChange={(event) => {
                            const replies = publicReplyFields(draft.publicReplyMessages);
                            replies[index] = event.target.value.replace(/\n/g, " ");
                            setDraft({ ...draft, publicReplyMessages: replies.join("\n") });
                          }}
                          className={inputClass}
                          placeholder={
                            index === 0
                              ? "Sent it to your DMs ✨"
                              : index === 1
                                ? "Check your messages 💌"
                                : "On its way 🙌"
                          }
                        />
                      </Field>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <Field label="Automation name">
              <input
                value={draft.name}
                maxLength={80}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                className={inputClass}
                placeholder="Send product link"
              />
            </Field>

            {supportsSuggestedReply && (
              <div className="rounded-2xl border border-border/70 bg-card p-4">
                <p className="text-sm font-semibold">First private message</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Every comment automation starts with one Send it action. There is no second tap.
                </p>
                <div className="mt-4 space-y-3">
                  <Field label="Opening message">
                    <textarea
                      value={draft.openingMessage}
                      maxLength={1000}
                      rows={3}
                      onChange={(event) =>
                        setDraft({ ...draft, openingMessage: event.target.value })
                      }
                      className={`${inputClass} resize-none`}
                      placeholder="Thanks for your comment!"
                    />
                  </Field>
                  <Field label="Reply button text">
                    <input
                      value={draft.confirmationButtonLabel}
                      maxLength={20}
                      onChange={(event) =>
                        setDraft({ ...draft, confirmationButtonLabel: event.target.value })
                      }
                      className={inputClass}
                      placeholder="Send it"
                    />
                  </Field>
                </div>
              </div>
            )}

            {supportsSuggestedReply && (
              <div className="rounded-2xl border border-border/70 bg-card p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold">Check they follow you</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Checked immediately after Send it. Non-followers can retry up to three times.
                    </p>
                  </div>
                  <Switch
                    checked={draft.followGateEnabled}
                    onCheckedChange={(followGateEnabled) =>
                      setDraft({ ...draft, followGateEnabled })
                    }
                  />
                </div>
                {draft.followGateEnabled && (
                  <div className="mt-4 space-y-3">
                    <Field label="Follow prompt">
                      <textarea
                        value={draft.followPromptMessage}
                        maxLength={700}
                        rows={3}
                        onChange={(event) =>
                          setDraft({ ...draft, followPromptMessage: event.target.value })
                        }
                        className={`${inputClass} resize-none`}
                      />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Maximum checks">
                        <select
                          value={draft.followMaxRechecks}
                          onChange={(event) =>
                            setDraft({ ...draft, followMaxRechecks: Number(event.target.value) })
                          }
                          className={inputClass}
                        >
                          {[1, 2, 3].map((count) => (
                            <option key={count} value={count}>
                              {count}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="If they still do not follow">
                        <select
                          value={draft.followFailAction}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              followFailAction: event.target.value as Draft["followFailAction"],
                            })
                          }
                          className={inputClass}
                        >
                          <option value="send_anyway">Send it anyway</option>
                          <option value="withhold">Do not send</option>
                        </select>
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            )}

            {supportsSuggestedReply && (
              <div className="rounded-2xl border border-border/70 bg-card p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold">Collect an email before delivery</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      After they tap the suggested reply, Bento asks for an email and saves it to
                      Audience.
                    </p>
                  </div>
                  <Switch
                    checked={draft.emailCaptureEnabled}
                    onCheckedChange={(emailCaptureEnabled) =>
                      setDraft({
                        ...draft,
                        emailCaptureEnabled,
                        openingMessage: emailCaptureEnabled
                          ? draft.openingMessage ||
                            "Thanks for reaching out! I have it ready for you."
                          : draft.openingMessage,
                        confirmationButtonLabel: emailCaptureEnabled
                          ? draft.confirmationButtonLabel || "Send it"
                          : draft.confirmationButtonLabel,
                        emailPromptMessage: emailCaptureEnabled
                          ? draft.emailPromptMessage ||
                            "What’s the best email address to send this to?"
                          : draft.emailPromptMessage,
                        emailMarketingConsentEnabled: emailCaptureEnabled
                          ? draft.emailMarketingConsentEnabled
                          : false,
                      })
                    }
                  />
                </div>
                {draft.emailCaptureEnabled && (
                  <div className="mt-4 space-y-4">
                    <Field label="Email prompt">
                      <textarea
                        value={draft.emailPromptMessage}
                        maxLength={700}
                        rows={3}
                        onChange={(event) =>
                          setDraft({ ...draft, emailPromptMessage: event.target.value })
                        }
                        className={`${inputClass} resize-none`}
                        placeholder="What’s the best email address to send this to?"
                      />
                    </Field>
                    <div className={`flex items-center justify-between gap-4 p-3 ${micro.soft}`}>
                      <div>
                        <p className="text-sm font-semibold">Ask for marketing consent</p>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                          Bento appends a clear disclosure and records consent. The disclosure
                          cannot be removed.
                        </p>
                      </div>
                      <Switch
                        checked={draft.emailMarketingConsentEnabled}
                        onCheckedChange={(emailMarketingConsentEnabled) =>
                          setDraft({ ...draft, emailMarketingConsentEnabled })
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <Field
              label={
                supportsSuggestedReply && draft.emailCaptureEnabled
                  ? "Message after they share their email"
                  : supportsSuggestedReply && draft.openingMessage
                    ? "Message after they tap the suggested reply"
                    : "Private DM reply"
              }
            >
              <textarea
                value={draft.replyMessage}
                maxLength={1000}
                rows={4}
                onChange={(event) => setDraft({ ...draft, replyMessage: event.target.value })}
                className={`${inputClass} resize-none`}
                placeholder="Write the message they will receive…"
              />
              <div className="mt-1 text-right text-[11px] text-muted-foreground">
                {draft.replyMessage.length}/1000
              </div>
            </Field>

            <div className="space-y-3">
              <Field label="Final link button text" hint="Optional">
                <input
                  value={draft.replyButtonLabel}
                  maxLength={20}
                  onChange={(event) => setDraft({ ...draft, replyButtonLabel: event.target.value })}
                  className={inputClass}
                  placeholder="Get the guide"
                />
              </Field>
              <Field label="Secure destination URL">
                <input
                  value={draft.replyButtonUrl}
                  onChange={(event) => setDraft({ ...draft, replyButtonUrl: event.target.value })}
                  className={inputClass}
                  placeholder="https://…"
                />
                {!validUrl && (
                  <p className="mt-1 text-xs text-rose-600">Use a valid https:// URL.</p>
                )}
              </Field>
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-3 text-sm font-medium">
            <Switch
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            Turn on after saving
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={step === 1 ? onCancel : () => setStep(step - 1)}
              className={micro.btnSoft}
            >
              {step === 1 ? "Cancel" : "Back"}
            </button>
            {step < 3 ? (
              <button
                type="button"
                disabled={!stepValid}
                onClick={() => setStep(step + 1)}
                className={micro.btnPrimary}
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                disabled={!canSave || saving}
                onClick={onSave}
                className={micro.btnPrimary}
              >
                {saving ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Launch Auto-DM
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
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
  automation: InstagramDmAutomation;
  busy: boolean;
  onEdit: () => void;
  onPreflight: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const [testOpen, setTestOpen] = useState(false);
  const [testText, setTestText] = useState(automation.keywords[0] || "Looks great");
  const testResult = testInstagramAutomation(automation, testText);
  const needsTestText = ![
    "any_comment",
    "any_dm",
    "any_story_reply",
    "any_live_comment",
    "post_share",
  ].includes(automation.triggerType);
  const label =
    automation.triggerType === "any_comment"
      ? "Any comment"
      : automation.triggerType === "dm_keyword"
        ? "DM keyword"
        : automation.triggerType === "any_dm"
          ? "Any DM"
          : automation.triggerType === "story_reply_keyword"
            ? "Story keyword"
            : automation.triggerType === "any_story_reply"
              ? "Any story reply"
              : automation.triggerType === "live_comment_keyword"
                ? "Live keyword"
                : automation.triggerType === "any_live_comment"
                  ? "Any Live comment"
                  : automation.triggerType === "post_share"
                    ? "Post shared"
                    : "Comment keyword";
  const verifiedLabel = automation.connectionLastVerifiedAt
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(automation.connectionLastVerifiedAt))
    : null;
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
            {automation.emailCaptureEnabled && (
              <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                Email capture
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">@{automation.connectionHandle}</p>
          {automation.keywords.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {automation.keywords.map((keyword) => (
                <span
                  key={keyword}
                  className="rounded-full bg-[#ffd6e6]/65 px-2.5 py-1 text-xs dark:bg-[#b72d64]/20"
                >
                  {keyword}
                </span>
              ))}
            </div>
          )}
          <p className="mt-3 line-clamp-2 text-sm leading-5 text-foreground/75">
            “{automation.replyMessage}”
          </p>
        </div>
        <Switch
          checked={automation.enabled}
          disabled={busy || !automation.connectionReady}
          onCheckedChange={onToggle}
          aria-label={automation.enabled ? "Disable automation" : "Enable automation"}
        />
      </div>
      <div className="mt-4 flex flex-col gap-3 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs">
          <p
            className={`font-medium ${automation.connectionReady ? "text-emerald-600 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}
          >
            {automation.connectionReady
              ? automation.enabled
                ? "Live · official Meta connection verified"
                : "Paused · official Meta connection verified"
              : automation.connectionNeedsReconnect
                ? "Reconnect required"
                : "Meta preflight required"}
          </p>
          {automation.connectionReady && verifiedLabel ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Last verified {verifiedLabel}
            </p>
          ) : automation.connectionReadinessMessage ? (
            <p className="mt-0.5 max-w-md text-[11px] leading-4 text-muted-foreground">
              {automation.connectionReadinessMessage}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setTestOpen((open) => !open)}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-muted-foreground hover:bg-accent"
            aria-expanded={testOpen}
            aria-controls={`automation-test-${automation.id}`}
          >
            <Beaker className="size-3.5" /> Test rule
          </button>
          <button
            type="button"
            onClick={onPreflight}
            disabled={busy || automation.connectionNeedsReconnect}
            className="inline-flex h-9 items-center justify-center rounded-xl px-3 text-xs font-semibold text-muted-foreground hover:bg-accent disabled:opacity-45"
            aria-label={`Run official Meta preflight for ${automation.name}`}
            title={
              automation.connectionNeedsReconnect
                ? "Reconnect Instagram before running preflight"
                : "Verify permissions and webhook subscriptions with Meta"
            }
          >
            {automation.connectionReady ? "Recheck Meta" : "Run Meta preflight"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex size-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent sm:size-9"
            aria-label="Edit automation"
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="inline-flex size-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-45 sm:size-9"
            aria-label="Delete automation"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
      {testOpen && (
        <div id={`automation-test-${automation.id}`} className={`${micro.soft} mt-3 p-4`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            {needsTestText ? (
              <label className="min-w-0 flex-1">
                <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Sample incoming message
                </span>
                <input
                  value={testText}
                  onChange={(event) => setTestText(event.target.value)}
                  maxLength={1_000}
                  className={`${inputClass} bg-background`}
                  placeholder="Type the comment or DM you want to test"
                />
              </label>
            ) : (
              <p className="flex-1 text-xs leading-5 text-muted-foreground">
                This trigger matches any eligible {label.toLocaleLowerCase()} event.
              </p>
            )}
            <span
              role="status"
              className={`inline-flex h-10 shrink-0 items-center justify-center rounded-xl px-3 text-xs font-semibold ${testResult.matches ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/10 text-rose-700 dark:text-rose-300"}`}
            >
              {testResult.matches ? "Rule matches" : "No match"}
            </span>
          </div>
          {testResult.matches && (
            <div className="mt-3 space-y-2 text-xs leading-5 text-foreground/75">
              {automation.publicReplyEnabled && automation.publicReplyMessages[0] && (
                <p>
                  <span className="font-semibold text-foreground">Public reply:</span>{" "}
                  {automation.publicReplyMessages[0]}
                </p>
              )}
              {automation.openingMessage && automation.confirmationButtonLabel && (
                <p>
                  <span className="font-semibold text-foreground">Opening DM:</span>{" "}
                  {automation.openingMessage} · Suggested reply “
                  {automation.confirmationButtonLabel}”
                </p>
              )}
              {automation.emailCaptureEnabled && automation.emailPromptMessage && (
                <p>
                  <span className="font-semibold text-foreground">Then asks:</span>{" "}
                  {automation.emailPromptMessage}
                </p>
              )}
              <p>
                <span className="font-semibold text-foreground">Final DM:</span>{" "}
                {automation.replyMessage}
                {automation.replyButtonLabel ? ` · Button “${automation.replyButtonLabel}”` : ""}
              </p>
            </div>
          )}
          <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
            Dry run only. It uses the live rule matcher but never contacts Meta or sends a message.
          </p>
        </div>
      )}
    </article>
  );
}

function ActivityRow({ event }: { event: InstagramDmActivity }) {
  return (
    <div className="flex items-center gap-3 py-3.5 first:pt-0 last:pb-0">
      <div
        className={`flex size-10 shrink-0 items-center justify-center rounded-2xl ${event.eventType === "comment" ? "bg-[#dceaff] text-[#3478f6]" : "bg-[#ffd6e6]/65"}`}
      >
        <MessageCircleReply className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="truncate font-semibold">{event.senderLabel}</span>
          <EventStatus status={event.status} />
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {event.automationName || "No matching automation"}
          {event.matchedKeyword ? ` · “${event.matchedKeyword}”` : ""}
          {event.errorMessage ? ` · ${event.errorMessage}` : ""}
        </p>
      </div>
      <time className="hidden text-right text-[11px] text-muted-foreground sm:block">
        {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(event.createdAt),
        )}
      </time>
    </div>
  );
}

function WorkflowRow({ workflow }: { workflow: InstagramDmWorkflow }) {
  const label = workflow.status.replaceAll("_", " ");
  const statusClass =
    workflow.status === "completed"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : workflow.status === "failed" || workflow.status === "expired"
        ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
        : "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return (
    <div className="flex items-center gap-3 py-3.5 first:pt-0 last:pb-0">
      <div className={`${micro.iconWellMint} size-10 shrink-0`}>
        <MessagesSquare className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="truncate font-semibold">{workflow.senderLabel}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${statusClass}`}
          >
            {label}
          </span>
          {workflow.emailCaptured && (
            <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300">
              Email captured{workflow.marketingConsent ? " · consented" : ""}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {workflow.automationName || "Automation"}
          {workflow.errorMessage ? ` · ${workflow.errorMessage}` : ""}
        </p>
      </div>
      <time className="hidden text-right text-[11px] text-muted-foreground sm:block">
        {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(workflow.createdAt),
        )}
      </time>
    </div>
  );
}

function EventStatus({ status }: { status: InstagramDmActivity["status"] }) {
  const styles: Record<InstagramDmActivity["status"], string> = {
    received: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
    processing: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    sent: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    failed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function Field({
  label,
  hint,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
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
      <div className="mt-4 font-ui-display text-4xl">{value}</div>
      <div className="mt-1 text-xs font-medium text-[#17213a]/55">{label}</div>
    </MicroAppStatCard>
  );
}

function splitList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function publicReplyFields(value: string) {
  return [...value.split("\n").slice(0, 3), "", "", ""].slice(0, 3);
}

const inputClass = micro.input;
