import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, PanelLeftClose, PanelLeftOpen, Plus, Search, Send, Sparkles } from "lucide-react";
import { BentoIcon } from "@/components/BentoBrand";
import { ContentAgentCard } from "./ContentAgentCard";
import { contentAgentResultSchema } from "@/lib/content-agent";
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
  last_message_at: string;
  created_at: string;
};

const starters = [
  ["Write a post in my voice", "Write a post in my voice using my Brain and recent work."],
  ["Analyze my recent posts", "Analyze my recent posts and tell me what to repeat next."],
  ["Plan this week's posts", "Plan this week's posts using my Brain and empty schedule slots."],
] as const;

export function ContentAgent({
  threads,
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
}: {
  threads: ContentAgentThread[];
  activeThreadId: string | null;
  messages: ContentAgentMessage[];
  seed: string;
  brainEmpty: boolean;
  sending: boolean;
  onSaveDraft?: (messageId: string, cardId: string, body: string) => void | Promise<void>;
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
  ) => void | Promise<void>;
}) {
  const [text, setText] = useState(seed);
  const [search, setSearch] = useState("");
  const [conversationsCollapsed, setConversationsCollapsed] = useState(false);
  const [sendError, setSendError] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messageEnd.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, sending]);

  useEffect(() => {
    if (seed) setText(seed);
  }, [seed]);

  const filteredThreads = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) => threadTitle(thread).toLowerCase().includes(query));
  }, [search, threads]);

  const send = async (value = text) => {
    const message = value.trim();
    if (!message || sending) return;
    setSendError("");
    try {
      await onSend(message);
      setText("");
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Could not send. Your message is still here.",
      );
    }
  };

  const composer = (
    <form
      className="mx-auto w-full max-w-4xl"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="flex items-end gap-2 rounded-[24px] border border-neutral-200 bg-neutral-50 p-2.5 pl-4 focus-within:border-neutral-400">
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
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-base leading-6 text-[#17213a] outline-none placeholder:text-[#17213a]/35"
          placeholder="What are we creating today?"
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!text.trim() || sending}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[#202123] text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Send className="size-4" />
        </button>
      </div>
    </form>
  );

  return (
    <section
      className={`content-workspace grid h-[calc(100dvh-7rem)] lg:h-[calc(100dvh-3.5rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-rows-1 ${
        conversationsCollapsed
          ? "md:grid-cols-[64px_minmax(0,1fr)]"
          : "md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]"
      }`}
    >
      <aside
        className={`flex max-h-32 min-h-0 flex-col border-b border-black/[0.07] bg-white md:max-h-none md:border-b-0 md:border-r ${
          conversationsCollapsed ? "p-2" : "p-4"
        }`}
      >
        <div
          className={`flex items-center gap-2 ${conversationsCollapsed ? "justify-center" : "justify-between px-1"}`}
        >
          {!conversationsCollapsed && (
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/45">
              Conversations
            </p>
          )}
          <button
            type="button"
            onClick={() => setConversationsCollapsed((current) => !current)}
            className="inline-flex size-8 items-center justify-center rounded-lg text-[#17213a]/45 hover:bg-white hover:text-[#17213a]"
            aria-label={conversationsCollapsed ? "Expand conversations" : "Collapse conversations"}
            aria-expanded={!conversationsCollapsed}
          >
            {conversationsCollapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={onNewThread}
          aria-label="New chat"
          title={conversationsCollapsed ? "New chat" : undefined}
          className={`mt-4 inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-black/[0.07] bg-white text-sm font-semibold text-[#17213a] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
            conversationsCollapsed ? "px-0" : "px-3"
          }`}
        >
          <Plus className="size-4" /> {!conversationsCollapsed && "New chat"}
        </button>
        {!conversationsCollapsed && (
          <>
            <label className="relative mt-4 block">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-[#17213a]/35" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search conversations"
                placeholder="Search conversations"
                className="h-10 w-full rounded-xl border border-black/[0.07] bg-white pl-12 pr-3 text-sm text-[#17213a] outline-none focus:border-[#3478f6]/35 focus:ring-2 focus:ring-[#3478f6]/10"
              />
            </label>
            <div className="mt-5 min-h-0 space-y-1 overflow-y-auto">
              <p className="px-2 pb-1 text-[11px] font-semibold text-[#17213a]/40">Recent</p>
              {!filteredThreads.length && (
                <p className="px-2 py-4 text-xs leading-5 text-[#17213a]/42">
                  {threads.length
                    ? "No matching conversations."
                    : "Your conversations will appear here."}
                </p>
              )}
              {filteredThreads.map((thread) => {
                const active = activeThreadId === thread.id;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => onSelectThread(thread.id)}
                    aria-current={active ? "page" : undefined}
                    className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                      active ? "bg-[#eef5ff] text-[#17213a]" : "text-[#17213a]/65 hover:bg-white"
                    }`}
                  >
                    <span className="block truncate text-sm font-semibold">
                      {threadTitle(thread)}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-[#17213a]/40">
                      {formatThreadDate(thread.last_message_at || thread.created_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
        {brainEmpty && (
          <div className="mx-5 mt-3 flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-100 pb-3 text-sm">
            <p className="font-semibold text-[#17213a]">Give Agent your starting context.</p>
            <p className={`mt-1 ${micro.mutedXs}`}>
              Bento can suggest editable stories, voice rules, and strategy from your own posts.
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

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-7" aria-live="polite">
          {!messages.length ? (
            <div className="m-auto flex w-full max-w-3xl flex-col items-center px-2 py-8 text-center">
              <span className="flex size-12 items-center justify-center">
                <BentoIcon className="size-10" />
              </span>
              <p className={`${micro.eyebrow} mt-6`}>Your AI Head of Content</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight">Ask Bento</h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-[#17213a]/50">
                Research ideas, write in your voice, and prepare review-ready posts from everything
                in your Brain.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {starters.map(([label, prompt]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => send(prompt)}
                    className="rounded-lg px-4 py-2 text-sm text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-4xl flex-1 space-y-5 py-3">
              <div className="mb-7 flex items-center gap-3 border-b border-black/[0.06] pb-4">
                <span className={`${micro.iconWell} size-9`}>
                  <Bot className="size-4" />
                </span>
                <div>
                  <h2 className="font-semibold text-[#17213a]">Bento Agent</h2>
                  <p className={micro.mutedXs}>Grounded in your Brain and connected sources</p>
                </div>
              </div>
              {messages.map((message) => {
                if (message.role === "user") {
                  return (
                    <div
                      key={message.id}
                      className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-3xl bg-neutral-100 px-5 py-3 text-[15px] leading-7 text-foreground"
                    >
                      {message.content}
                    </div>
                  );
                }
                if (message.role === "system_event") {
                  return (
                    <p key={message.id} className="text-center text-xs text-[#17213a]/45">
                      {message.content}
                    </p>
                  );
                }
                const parsed = contentAgentResultSchema.safeParse(message.payload);
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
                            onApproveSchedule(message.id, draftCardId, scheduleCardId)
                          }
                        />
                      ))}
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

        <div className="shrink-0 bg-white px-4 pb-20 pt-2 sm:px-7">
          {composer}
          {sendError && (
            <p role="alert" className="mx-auto mt-2 max-w-4xl text-xs text-red-700">
              {sendError}
            </p>
          )}
          <p className="mt-2 text-center text-[11px] text-neutral-400">
            Bento uses your Brain. Review facts and schedules before publishing.
          </p>
        </div>
      </div>
    </section>
  );
}

function threadTitle(thread: ContentAgentThread) {
  return thread.title?.trim() || "New conversation";
}

function formatThreadDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
