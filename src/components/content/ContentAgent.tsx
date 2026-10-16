import type { SchedulerConnection } from "@/lib/social-scheduler";
import type { AgentDraftEdit } from "@/lib/content-carousel";
import { storedContentAgentResultSchema } from "@/lib/content-agent-proactive";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  Sparkles,
  Settings2,
  Pin,
  PinOff,
  RotateCw,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BentoIcon } from "@/components/BentoBrand";
import { ContentAgentCard } from "./ContentAgentCard";
import { ContentMarkdown } from "./ContentDocument";
import { micro } from "@/lib/micro-app-ui";

export type ContentAgentMessage = {
  id: string;
  role: "user" | "assistant" | "system_event";
  content: string;
  payload?: unknown;
  created_at?: string;
};

export type ContentAgentThread = {
  id: string;
  title: string | null;
  kind?: "agent" | "chat";
  pinned_at?: string | null;
  unread_count?: number;
  last_message_at: string;
  created_at: string;
};

const starters = [
  ["Write a post in my voice", "Write a post in my voice using my Brain and recent work."],
  [
    "What should I sell?",
    "Use my store products, sales and social insights to recommend what I should sell next. Explain the evidence, audience, offer and one small experiment to validate demand.",
  ],
  [
    "Grow my business",
    "Review my content and business. Identify the biggest opportunity to grow revenue, explain the evidence and give me three concrete next steps.",
  ],
  ["Analyze my recent posts", "Analyze my recent posts and tell me what to repeat next."],
  ["Plan this week's posts", "Plan this week's posts using my Brain and empty schedule slots."],
] as const;

export function ContentAgent({
  threads,
  previewAccounts = [],
  agentName = "Bento",
  agentThreadId,
  onPinThread,
  onRenameThread,
  onDeleteThread,
  onMarkRead,
  onOpenSettings,
  identityUnavailable = false,
  onRetryIdentity,
  hasMoreThreads = false,
  loadingMoreThreads = false,
  onLoadMore,
  loadingThreads = false,
  threadListError,
  onRetryThreads,
  pinningThreadId,
  renderMessageFooter,
  activeThreadTitle,
  loading = false,
  readEnabled = true,
  loadError,
  onRetry,
  activeThreadId,
  messages,
  seed,
  brainEmpty,
  sending,
  onNewThread,
  onSelectThread,
  onSend,
  onBuildBrain,
  onApproveBrain,
  onRejectDraft,
  onRegenerateDraft,
  onApproveSchedule,
  onSaveDraft,
  onDraftChanged,
}: {
  threads: ContentAgentThread[];
  previewAccounts?: SchedulerConnection[];
  agentName: string;
  agentThreadId: string | null;
  onPinThread: (threadId: string, pinned: boolean) => void | Promise<void>;
  onRenameThread: (threadId: string, title: string) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onMarkRead: (threadId: string, throughMessageId: string) => void | Promise<void>;
  onOpenSettings: () => void;
  identityUnavailable?: boolean;
  onRetryIdentity?: () => void;
  hasMoreThreads?: boolean;
  loadingMoreThreads?: boolean;
  onLoadMore?: () => void;
  loadingThreads?: boolean;
  threadListError?: string;
  onRetryThreads?: () => void;
  pinningThreadId?: string;
  renderMessageFooter?: (message: ContentAgentMessage) => ReactNode;
  activeThreadTitle?: string;
  loading?: boolean;
  readEnabled?: boolean;
  loadError?: string;
  onRetry?: () => void;
  activeThreadId: string | null;
  messages: ContentAgentMessage[];
  seed: string;
  brainEmpty: boolean;
  sending: boolean;
  onDraftChanged?: () => void | Promise<unknown>;
  onSaveDraft?: (messageId: string, cardId: string, edit: AgentDraftEdit) => void | Promise<void>;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onSend: (text: string) => void | Promise<void>;
  onBuildBrain: () => void | Promise<void>;
  onApproveBrain: (messageId: string, cardId: string) => void | Promise<void>;
  onRejectDraft: (messageId: string, cardId: string, reason: string) => void | Promise<void>;
  onRegenerateDraft: (messageId: string, cardId: string, reason: string) => void | Promise<void>;
  onApproveSchedule: (
    messageId: string,
    draftCardId: string,
    scheduleCardId: string,
    revision: number,
  ) => void | Promise<void>;
}) {
  const [text, setText] = useState(seed);
  const [search, setSearch] = useState("");
  const [conversationsCollapsed, setConversationsCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const readWatermark = useRef("");
  const [sendError, setSendError] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [renameTarget, setRenameTarget] = useState<ContentAgentThread | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContentAgentThread | null>(null);
  const [editedTitle, setEditedTitle] = useState("");
  const [threadActionError, setThreadActionError] = useState("");
  const [threadActionPending, setThreadActionPending] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messageEnd.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, sending]);

  useEffect(() => {
    if (seed) setText(seed);
  }, [seed]);

  const filteredThreads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return threads.filter(
      (thread) =>
        thread.id !== agentThreadId &&
        thread.kind !== "agent" &&
        (!query || threadTitle(thread).toLowerCase().includes(query)),
    );
  }, [search, threads, agentThreadId]);

  const displayedMessageId = messages.at(-1)?.id;
  useEffect(() => {
    const markDisplayed = () => {
      if (
        !activeThreadId ||
        !displayedMessageId ||
        loading ||
        loadError ||
        !readEnabled ||
        mobileOpen ||
        document.visibilityState === "hidden"
      )
        return;
      const watermark = `${activeThreadId}:${displayedMessageId}`;
      if (readWatermark.current === watermark) return;
      readWatermark.current = watermark;
      void onMarkRead(activeThreadId, displayedMessageId);
    };
    markDisplayed();
    document.addEventListener("visibilitychange", markDisplayed);
    return () => document.removeEventListener("visibilitychange", markDisplayed);
  }, [activeThreadId, displayedMessageId, loading, loadError, readEnabled, mobileOpen, onMarkRead]);

  const selectThread = (id: string | null) => {
    if (id) onSelectThread(id);
    else onNewThread();
    setMobileOpen(false);
    setSendError("");
    setPendingText("");
  };
  const unread = threads.find((item) => item.id === agentThreadId)?.unread_count || 0;
  const currentTitle =
    activeThreadId === agentThreadId
      ? agentName
      : activeThreadTitle ||
        threads.find((item) => item.id === activeThreadId)?.title ||
        "New chat";
  const pinned = filteredThreads.filter((item) => item.pinned_at);
  const recent = filteredThreads.filter((item) => !item.pinned_at);
  const navigation = (collapsed: boolean) => (
    <nav
      aria-label="Conversations"
      className="agent-navigation"
      onKeyDown={(event) => {
        if (!event.target || !(event.target as HTMLElement).hasAttribute("data-conversation"))
          return;
        const rows = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button[data-conversation]:not(:disabled)",
          ),
        );
        const index = rows.indexOf(event.target as HTMLButtonElement);
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % rows.length
            : event.key === "ArrowUp"
              ? (index - 1 + rows.length) % rows.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : null;
        if (next !== null) {
          event.preventDefault();
          rows[next]?.focus();
        }
      }}
    >
      <button
        type="button"
        className="agent-nav-row"
        data-conversation
        aria-label="New chat"
        title="New chat"
        onClick={() => selectThread(null)}
      >
        <Plus className="size-4 shrink-0" />
        {!collapsed && <span>New chat</span>}
      </button>
      <button
        type="button"
        className="agent-nav-row agent-named-row"
        data-conversation
        aria-label={agentName}
        title={agentName}
        disabled={!agentThreadId}
        aria-current={activeThreadId && activeThreadId === agentThreadId ? "page" : undefined}
        onClick={() => agentThreadId && selectThread(agentThreadId)}
      >
        <span className="agent-avatar">
          <BentoIcon className="size-5" />
        </span>
        {!collapsed && <span className="min-w-0 flex-1 truncate">{agentName}</span>}
        {unread > 0 && (
          <span
            className="agent-unread"
            aria-label={`${unread} unread ${unread === 1 ? "message" : "messages"}`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {!collapsed && (
        <>
          <label className="agent-search">
            <Search className="size-4" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search conversations"
              placeholder="Search chats"
            />
          </label>
          <div className="agent-chat-list">
            {(
              [
                ["Pinned", pinned],
                ["Recents", recent],
              ] as const
            ).map(([name, items]) => (
              <div key={name} className="agent-chat-group">
                <p className="agent-group-label">{name}</p>
                {items.map((item) => (
                  <div key={item.id} className="agent-chat-row">
                    <button
                      type="button"
                      className="agent-nav-row"
                      data-conversation
                      aria-current={activeThreadId === item.id ? "page" : undefined}
                      onClick={() => selectThread(item.id)}
                      title={threadTitle(item)}
                    >
                      <span className="min-w-0 flex-1 truncate">{threadTitle(item)}</span>
                      {!!item.unread_count && (
                        <span
                          className="agent-unread"
                          aria-label={`${item.unread_count} unread messages`}
                        >
                          {item.unread_count > 99 ? "99+" : item.unread_count}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="agent-pin"
                      disabled={pinningThreadId === item.id}
                      aria-label={`${item.pinned_at ? "Unpin" : "Pin"} ${threadTitle(item)}`}
                      onClick={() => void onPinThread(item.id, !item.pinned_at)}
                    >
                      {item.pinned_at ? (
                        <PinOff className="size-3.5" />
                      ) : (
                        <Pin className="size-3.5" />
                      )}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="agent-thread-more"
                          aria-label={`More options for ${threadTitle(item)}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            setMobileOpen(false);
                            setThreadActionError("");
                            setEditedTitle(threadTitle(item));
                            setRenameTarget(item);
                          }}
                        >
                          <Pencil /> Rename chat
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => {
                            setMobileOpen(false);
                            setThreadActionError("");
                            setDeleteTarget(item);
                          }}
                        >
                          <Trash2 /> Delete chat
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            ))}
            {!filteredThreads.length && !loadingThreads && !threadListError && (
              <p className="agent-nav-empty">
                {search ? "No matching conversations." : "Your chats will appear here."}
              </p>
            )}
            {loadingThreads && (
              <p role="status" className="agent-nav-empty">
                Loading chats…
              </p>
            )}
            {threadListError && (
              <div className="agent-nav-empty">
                <p role="alert">{threadListError}</p>
                <button type="button" className="content-action mt-2" onClick={onRetryThreads}>
                  Retry chats
                </button>
              </div>
            )}
            {hasMoreThreads && !threadListError && (
              <button
                type="button"
                className="agent-load-more"
                disabled={loadingMoreThreads}
                onClick={onLoadMore}
              >
                {loadingMoreThreads ? "Loading chats…" : "Load more chats"}
              </button>
            )}
          </div>
        </>
      )}
    </nav>
  );

  const send = async (value = text) => {
    const message = value.trim();
    if (!message || sending || loading || loadError) return;
    setSendError("");
    setPendingText(message);
    try {
      await onSend(message);
      setText("");
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Could not send. Your message is still here.",
      );
    } finally {
      setPendingText("");
    }
  };

  const composer = (
    <form
      className="agent-composer mx-auto w-full max-w-3xl"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="agent-composer-field">
        <textarea
          aria-label="Message Agent"
          value={text}
          onChange={(event) => setText(event.target.value.slice(0, 20_000))}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="What are we building today?"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!text.trim() || sending || loading || !!loadError}
          className="agent-send"
        >
          <Send className="size-4" />
        </button>
      </div>
    </form>
  );

  return (
    <section
      className={`content-workspace agent-shell ${conversationsCollapsed ? "agent-collapsed" : ""}`}
      aria-label="Content chat"
    >
      <aside className="agent-desktop-sidebar">
        <button
          type="button"
          className="agent-collapse"
          onClick={() => setConversationsCollapsed((current) => !current)}
          aria-label={conversationsCollapsed ? "Expand conversations" : "Collapse conversations"}
          aria-expanded={!conversationsCollapsed}
        >
          {conversationsCollapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
        {navigation(conversationsCollapsed)}
      </aside>
      <div className="agent-conversation">
        <header className="agent-toolbar">
          <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
            <DialogTrigger asChild>
              <button
                ref={mobileTrigger}
                type="button"
                className="agent-mobile-trigger"
                aria-label="Open conversations"
              >
                <PanelLeftOpen className="size-5" />
              </button>
            </DialogTrigger>
            <DialogContent
              className="content-workspace agent-mobile-drawer translate-x-0 translate-y-0"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                mobileTrigger.current?.focus();
              }}
            >
              <DialogTitle className="sr-only">Conversations</DialogTitle>
              <DialogDescription className="sr-only">
                Start a chat, open your agent, or choose a saved conversation.
              </DialogDescription>
              {navigation(false)}
            </DialogContent>
          </Dialog>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{currentTitle}</span>
          {identityUnavailable && (
            <>
              <span
                role="status"
                className="max-w-[40%] truncate text-xs"
                title="Agent settings are unavailable. Your chat is still available."
              >
                Agent settings unavailable
              </span>
              <button
                type="button"
                className="agent-settings-button"
                aria-label="Retry agent settings"
                title="Retry agent settings"
                onClick={onRetryIdentity}
              >
                <RotateCw className="size-4" />
              </button>
            </>
          )}
          <button
            type="button"
            className="agent-settings-button"
            aria-label="Agent settings"
            title="Agent settings"
            disabled={!agentThreadId}
            onClick={onOpenSettings}
          >
            <Settings2 className="size-4" />
          </button>
        </header>
        {brainEmpty && (
          <div className="agent-brain-hint">
            <p className="font-semibold text-foreground">Give {agentName} your starting context.</p>
            <p className={`mt-1 ${micro.mutedXs}`}>
              {agentName} can suggest editable stories, voice rules, and strategy from your own
              posts.
            </p>
            <button
              type="button"
              onClick={() => void onBuildBrain()}
              className={`${micro.btnPrimary} mt-3`}
            >
              <Sparkles className="size-4" /> Build my Brain from my posts
            </button>
          </div>
        )}

        <div className="agent-messages" aria-live="polite">
          {loadError ? (
            <div className="m-auto text-center">
              <p role="alert" className="text-sm text-muted-foreground">
                {loadError}
              </p>
              <button type="button" className="content-action mt-3" onClick={onRetry}>
                Try again
              </button>
            </div>
          ) : loading ? (
            <p role="status" className="m-auto text-sm text-muted-foreground">
              Loading conversation…
            </p>
          ) : !messages.length && sending ? (
            <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 py-3">
              {pendingText && (
                <div className="ml-auto max-w-[85%] break-words whitespace-pre-wrap rounded-3xl bg-muted px-5 py-3 text-[15px] leading-7 text-foreground">
                  {pendingText}
                </div>
              )}
              <p role="status" className="text-sm text-muted-foreground">
                {agentName} is preparing your response…
              </p>
            </div>
          ) : !messages.length ? (
            <div className="m-auto flex w-full max-w-3xl flex-col items-center px-2 py-8 text-center">
              <span className="flex size-12 items-center justify-center">
                <BentoIcon className="size-10" />
              </span>
              <p className={`${micro.eyebrow} mt-6`}>Your head of content & monetization</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">Ask {agentName}</h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                Turn your ideas into content and your audience into a business. {agentName} uses
                your Brain, social insights, and store results to help you decide what to create and
                sell next.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {starters.map(([label, prompt]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => send(prompt)}
                    className="rounded-lg px-4 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 py-3">
              {messages.map((message) => {
                if (message.role === "user") {
                  return (
                    <div
                      key={message.id}
                      className="ml-auto max-w-[85%] break-words whitespace-pre-wrap rounded-3xl bg-muted px-5 py-3 text-[15px] leading-7 text-foreground"
                    >
                      {message.content}
                    </div>
                  );
                }
                if (message.role === "system_event") {
                  return (
                    <p key={message.id} className="text-center text-xs text-muted-foreground">
                      {message.content}
                    </p>
                  );
                }
                const parsed = storedContentAgentResultSchema.safeParse(message.payload);
                return (
                  <div key={message.id} className="max-w-3xl space-y-3">
                    <div className="flex items-start gap-3">
                      <span className={`${micro.iconWell} mt-0.5 size-8 shrink-0`}>
                        <Bot className="size-4" />
                      </span>
                      <ContentMarkdown text={message.content} />
                    </div>
                    {parsed.success &&
                      parsed.data.cards.map((card) => (
                        <ContentAgentCard
                          key={card.cardId}
                          messageId={message.id}
                          card={card}
                          previewAccounts={previewAccounts}
                          draftState={
                            parsed.data.draftStates?.[
                              card.type === "schedule_proposal" ? card.draftCardId : card.cardId
                            ]
                          }
                          onDraftChanged={onDraftChanged}
                          allCards={parsed.data.cards}
                          mediaAssets={parsed.data.mediaAssets}
                          onSaveDraft={
                            onSaveDraft
                              ? (cardId, body) => onSaveDraft(message.id, cardId, body)
                              : undefined
                          }
                          onApproveBrain={(cardId) => onApproveBrain(message.id, cardId)}
                          onRejectDraft={(cardId, reason) =>
                            onRejectDraft(message.id, cardId, reason)
                          }
                          onRegenerateDraft={(cardId, reason) =>
                            onRegenerateDraft(message.id, cardId, reason)
                          }
                          onApproveSchedule={(draftCardId, scheduleCardId) =>
                            onApproveSchedule(
                              message.id,
                              draftCardId,
                              scheduleCardId,
                              parsed.data.draftStates?.[draftCardId]?.revision || 0,
                            )
                          }
                        />
                      ))}
                    {renderMessageFooter?.(message)}
                  </div>
                );
              })}
              {sending && (
                <p role="status" className={micro.mutedXs}>
                  Agent is preparing your result…
                </p>
              )}
            </div>
          )}
          <div ref={messageEnd} />
        </div>

        <div className="agent-composer-area">
          {composer}
          {sendError && (
            <p role="alert" className="mx-auto mt-2 max-w-4xl text-xs text-red-700">
              {sendError}
            </p>
          )}
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            {agentName} uses your Brain. Review facts and schedules before publishing.
          </p>
        </div>
      </div>
      <Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogTitle>Rename chat</DialogTitle>
          <DialogDescription>
            Choose a name that makes this conversation easy to find.
          </DialogDescription>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!renameTarget || !editedTitle.trim() || threadActionPending) return;
              setThreadActionPending(true);
              setThreadActionError("");
              try {
                await onRenameThread(renameTarget.id, editedTitle.trim());
                setRenameTarget(null);
              } catch (error) {
                setThreadActionError(
                  error instanceof Error ? error.message : "Chat could not be renamed.",
                );
              } finally {
                setThreadActionPending(false);
              }
            }}
          >
            <input
              aria-label="Chat name"
              autoFocus
              maxLength={160}
              value={editedTitle}
              onChange={(event) => setEditedTitle(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            {threadActionError && (
              <p role="alert" className="text-sm text-destructive">
                {threadActionError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="content-action"
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={micro.btnPrimary}
                disabled={!editedTitle.trim() || threadActionPending}
              >
                {threadActionPending ? "Saving…" : "Save name"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogTitle>Delete chat?</DialogTitle>
          <DialogDescription>
            This permanently deletes “{deleteTarget ? threadTitle(deleteTarget) : ""}” and its
            messages. Posts already saved to the scheduler stay there.
          </DialogDescription>
          {threadActionError && (
            <p role="alert" className="text-sm text-destructive">
              {threadActionError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="content-action" onClick={() => setDeleteTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground"
              disabled={threadActionPending}
              onClick={async () => {
                if (!deleteTarget || threadActionPending) return;
                setThreadActionPending(true);
                setThreadActionError("");
                try {
                  await onDeleteThread(deleteTarget.id);
                  setDeleteTarget(null);
                } catch (error) {
                  setThreadActionError(
                    error instanceof Error ? error.message : "Chat could not be deleted.",
                  );
                } finally {
                  setThreadActionPending(false);
                }
              }}
            >
              {threadActionPending ? "Deleting…" : "Delete chat"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function threadTitle(thread: ContentAgentThread) {
  return thread.title?.trim() || "New conversation";
}
