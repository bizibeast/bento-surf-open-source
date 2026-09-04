import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Loader2, MessageSquareText, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { AppHeader } from "@/components/AppHeader";
import { formatCommerceMoney } from "@/lib/commerce";
import { micro } from "@/lib/micro-app-ui";
import {
  getMyPriorityDmConversationPage,
  getMyPriorityDmInbox,
  markCreatorPriorityDmRead,
  sendCreatorPriorityDmMessage,
  setPriorityDmConversationClosed,
} from "@/lib/priority-dm.functions";
import type {
  PriorityDmConversationSummary,
  PriorityDmConversationView,
  PriorityDmMessageCursor,
} from "@/lib/priority-dm.server";
import { createPriorityDmWebMcpTools } from "@/lib/priority-dm-webmcp";
import { useWebMcpTools } from "@/lib/webmcp";

const searchSchema = z.object({
  thread: z.string().uuid().optional().catch(undefined),
  filter: z.enum(["open", "closed"]).default("open").catch("open"),
});

export const Route = createFileRoute("/_authenticated/priority-dm")({
  head: () => ({ meta: [{ title: "Priority DM | bento.surf" }] }),
  validateSearch: searchSchema,
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["priority-dm"],
      queryFn: () => getMyPriorityDmInbox(),
    });
  },
  component: PriorityDmInboxPage,
});

function PriorityDmInboxPage() {
  const { filter, thread } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingReplyIds, setPendingReplyIds] = useState<Set<string>>(() => new Set());
  const [pendingCloseIds, setPendingCloseIds] = useState<Set<string>>(() => new Set());
  const markedReadVersions = useRef(new Set<string>());
  const inbox = useQuery({
    queryKey: ["priority-dm"],
    queryFn: () => getMyPriorityDmInbox(),
    refetchInterval: 30_000,
  });
  const conversations = (inbox.data ?? []) as PriorityDmConversationSummary[];
  const filtered = conversations.filter((conversation) =>
    filter === "closed" ? conversation.status === "closed" : conversation.status !== "closed",
  );
  const selected = filtered.find((conversation) => conversation.id === thread);
  const selectedId = selected?.id;
  const selectedStatus = selected?.status;
  const selectedLastMessageAt = selected?.lastMessageAt;
  const selectedThread = useInfiniteQuery({
    queryKey: ["priority-dm-thread", selectedId],
    queryFn: ({ pageParam }) =>
      getMyPriorityDmConversationPage({
        data: pageParam
          ? { requestId: selectedId!, before: pageParam }
          : { requestId: selectedId! },
      }),
    initialPageParam: null as PriorityDmMessageCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(selectedId),
    refetchInterval: 30_000,
  });
  const selectedConversation = useMemo(() => {
    const pages = selectedThread.data?.pages;
    if (!pages?.length) return undefined;
    return {
      ...pages[0].conversation,
      messages: [...pages].reverse().flatMap((page) => page.conversation.messages),
    };
  }, [selectedThread.data?.pages]);
  const unreadVersion =
    selectedId && selectedStatus === "unread"
      ? `${selectedId}:${selectedLastMessageAt}`
      : undefined;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const draft = selectedId ? (drafts[selectedId] ?? "") : "";
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["priority-dm"] }),
      queryClient.invalidateQueries({ queryKey: ["priority-dm-thread"] }),
    ]);
  };

  useWebMcpTools(createPriorityDmWebMcpTools({ conversations, refresh }));

  useEffect(() => {
    if (
      !selectedId ||
      !selectedLastMessageAt ||
      !unreadVersion ||
      markedReadVersions.current.has(unreadVersion)
    )
      return;
    markedReadVersions.current.add(unreadVersion);
    void markCreatorPriorityDmRead({
      data: { requestId: selectedId, lastMessageAt: selectedLastMessageAt },
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ["priority-dm"] }))
      .catch((error) => {
        markedReadVersions.current.delete(unreadVersion);
        toast.error(error instanceof Error ? error.message : "Could not mark conversation read");
      });
  }, [selectedId, selectedLastMessageAt, unreadVersion, queryClient]);

  const reply = useMutation({
    mutationFn: (input: { requestId: string; body: string }) =>
      sendCreatorPriorityDmMessage({ data: input }),
    onMutate: (input) => {
      setPendingReplyIds((current) => new Set(current).add(input.requestId));
    },
    onSuccess: async (_, input) => {
      setDrafts((current) =>
        current[input.requestId]?.trim() === input.body
          ? { ...current, [input.requestId]: "" }
          : current,
      );
      await refresh();
      toast.success("Reply sent");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Reply could not be sent"),
    onSettled: (_, __, input) => {
      setPendingReplyIds((current) => {
        const next = new Set(current);
        next.delete(input.requestId);
        return next;
      });
    },
  });
  const setClosed = useMutation({
    mutationFn: (input: { requestId: string; closed: boolean }) =>
      setPriorityDmConversationClosed({ data: input }),
    onMutate: (input) => {
      setPendingCloseIds((current) => new Set(current).add(input.requestId));
    },
    onSuccess: async (_, input) => {
      await refresh();
      if (selectedIdRef.current === input.requestId) {
        void navigate({
          to: "/priority-dm",
          search: { filter, thread: undefined },
          replace: true,
        });
      }
      toast.success(input.closed ? "Conversation closed" : "Conversation reopened");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Conversation could not be updated"),
    onSettled: (_, __, input) => {
      setPendingCloseIds((current) => {
        const next = new Set(current);
        next.delete(input.requestId);
        return next;
      });
    },
  });

  return (
    <div className={`overflow-x-clip ${micro.shell}`}>
      <AppHeader title="Priority DM" />
      <main className={`${micro.main} min-w-0 py-5 sm:py-7`}>
        <div className="mb-5 flex min-w-0 items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-ui-display text-2xl text-foreground sm:text-3xl">
              Paid conversations
            </h1>
            <p className={`mt-1 ${micro.muted}`}>
              Read requests, reply, and keep every follow-up in one thread.
            </p>
          </div>
          <Link
            to="/store"
            search={{ tab: "products", create: "priority_dm" }}
            className={micro.btnOutline}
          >
            New product
          </Link>
        </div>

        <div className="grid min-h-[36rem] min-w-0 overflow-hidden rounded-[28px] border border-border bg-card shadow-sm lg:grid-cols-[20rem_minmax(0,1fr)]">
          <ConversationList
            conversations={filtered}
            allCount={conversations.length}
            filter={filter}
            selectedId={selectedId}
            loading={inbox.isLoading}
            error={inbox.error}
            onRetry={() => void inbox.refetch()}
            onFilter={(nextFilter) =>
              navigate({
                to: "/priority-dm",
                search: { filter: nextFilter, thread: undefined },
                replace: true,
              })
            }
            onSelect={(requestId) =>
              navigate({
                to: "/priority-dm",
                search: { filter, thread: requestId },
              })
            }
          />
          <ConversationDetail
            conversation={selectedConversation}
            selected={Boolean(selectedId)}
            loading={selectedThread.isLoading}
            error={selectedThread.error}
            loadingEarlier={selectedThread.isFetchingNextPage}
            hasEarlier={Boolean(selectedThread.hasNextPage)}
            filter={filter}
            draft={draft}
            sending={selectedId ? pendingReplyIds.has(selectedId) : false}
            updating={selectedId ? pendingCloseIds.has(selectedId) : false}
            onDraftChange={(value) => {
              if (!selectedId) return;
              setDrafts((current) => ({ ...current, [selectedId]: value }));
            }}
            onBack={() =>
              navigate({
                to: "/priority-dm",
                search: { filter, thread: undefined },
                replace: true,
              })
            }
            onReply={() => {
              if (!selectedId || !draft.trim()) return;
              reply.mutate({ requestId: selectedId, body: draft.trim() });
            }}
            onSetClosed={(closed) => {
              if (selectedId) setClosed.mutate({ requestId: selectedId, closed });
            }}
            onLoadEarlier={() => void selectedThread.fetchNextPage()}
          />
        </div>
      </main>
    </div>
  );
}

function ConversationList({
  conversations,
  allCount,
  filter,
  selectedId,
  loading,
  error,
  onRetry,
  onFilter,
  onSelect,
}: {
  conversations: PriorityDmConversationSummary[];
  allCount: number;
  filter: "open" | "closed";
  selectedId?: string;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  onFilter: (filter: "open" | "closed") => void;
  onSelect: (requestId: string) => void;
}) {
  return (
    <aside
      aria-label="Priority DM conversations"
      className={`${selectedId ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-col border-border lg:border-r`}
    >
      <div className="flex gap-1 border-b border-border p-3">
        {(["open", "closed"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => onFilter(value)}
            className={`min-h-9 flex-1 rounded-xl px-3 text-xs font-semibold capitalize outline-none transition focus-visible:ring-2 focus-visible:ring-ring ${
              filter === value
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading conversations…
          </div>
        ) : error && allCount === 0 ? (
          <div className="p-5 text-center text-sm text-muted-foreground">
            <p>Conversations could not be loaded.</p>
            <button type="button" onClick={onRetry} className="mt-3 font-semibold text-foreground">
              Try again
            </button>
          </div>
        ) : conversations.length ? (
          <div className="space-y-1">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                aria-label={`${conversation.status === "unread" ? "Unread, " : ""}${conversation.buyerName || conversation.buyerEmail || "Buyer"}, ${conversation.productTitle}`}
                aria-pressed={selectedId === conversation.id}
                onClick={() => onSelect(conversation.id)}
                className={`w-full min-w-0 rounded-2xl border p-3 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-ring ${
                  selectedId === conversation.id
                    ? "border-border bg-accent"
                    : "border-transparent hover:bg-accent/70"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {conversation.status === "unread" && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-[#3478f6]"
                      aria-label="Unread"
                    />
                  )}
                  <span
                    className={`truncate text-sm ${conversation.status === "unread" ? "font-semibold" : "font-medium"}`}
                  >
                    {conversation.buyerName || conversation.buyerEmail || "Buyer"}
                  </span>
                  <time className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {formatConversationTime(conversation.lastMessageAt)}
                  </time>
                </div>
                <div className="mt-1 truncate text-[11px] font-medium text-muted-foreground">
                  {conversation.productTitle}
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {conversation.lastMessagePreview}
                </p>
              </button>
            ))}
          </div>
        ) : allCount === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center p-5 text-center">
            <MessageSquareText className="size-8 text-[#3478f6]" />
            <h2 className="mt-4 font-ui-display text-xl">No priority messages yet</h2>
            <p className={`mt-2 ${micro.mutedXs}`}>
              Create a Priority DM product and paid requests will appear here.
            </p>
            <Link
              to="/store"
              search={{ tab: "products", create: "priority_dm" }}
              className={`${micro.btnPrimaryCompact} mt-4`}
            >
              Create a Priority DM product
            </Link>
          </div>
        ) : (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No {filter} conversations.
          </p>
        )}
      </div>
    </aside>
  );
}

function ConversationDetail({
  conversation,
  selected,
  loading,
  error,
  loadingEarlier,
  hasEarlier,
  filter,
  draft,
  sending,
  updating,
  onDraftChange,
  onBack,
  onReply,
  onSetClosed,
  onLoadEarlier,
}: {
  conversation?: PriorityDmConversationView;
  selected: boolean;
  loading: boolean;
  error: Error | null;
  loadingEarlier: boolean;
  hasEarlier: boolean;
  filter: "open" | "closed";
  draft: string;
  sending: boolean;
  updating: boolean;
  onDraftChange: (value: string) => void;
  onBack: () => void;
  onReply: () => void;
  onSetClosed: (closed: boolean) => void;
  onLoadEarlier: () => void;
}) {
  if (!conversation) {
    return (
      <section
        className={`${selected ? "flex" : "hidden lg:flex"} min-w-0 items-center justify-center p-8 text-center`}
      >
        <div>
          {loading ? (
            <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
          ) : (
            <MessageSquareText className="mx-auto size-9 text-muted-foreground/40" />
          )}
          <h2 className="mt-4 font-ui-display text-xl">
            {loading
              ? "Loading conversation"
              : error
                ? "Conversation could not be loaded"
                : "Choose a conversation"}
          </h2>
          <p className={`mt-2 ${micro.mutedXs}`}>
            {error ? error.message : "Messages and reply controls will appear here."}
          </p>
        </div>
      </section>
    );
  }
  const buyerName = conversation.buyerName || conversation.buyerEmail || "Buyer";
  const messages = [...conversation.messages].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  return (
    <section
      aria-label={`Conversation with ${buyerName}`}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <header className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-3 sm:px-5">
        <button
          type="button"
          aria-label="Back to conversations"
          onClick={onBack}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{buyerName}</h2>
          <p className="truncate text-xs text-muted-foreground">{conversation.productTitle}</p>
        </div>
        <button
          type="button"
          disabled={updating}
          aria-label={filter === "closed" ? "Reopen conversation" : "Close conversation"}
          onClick={() => onSetClosed(filter !== "closed")}
          className="ml-auto inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {updating ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : filter === "closed" ? (
            <Check className="size-3.5" />
          ) : (
            <X className="size-3.5" />
          )}
          <span className="hidden sm:inline">{filter === "closed" ? "Reopen" : "Close"}</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/25 px-3 py-5 sm:px-6">
        <div className="mx-auto max-w-2xl space-y-3">
          {hasEarlier && (
            <div className="pb-2 text-center">
              <button
                type="button"
                disabled={loadingEarlier}
                onClick={onLoadEarlier}
                className="min-h-9 rounded-xl border border-border bg-card px-3 text-xs font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {loadingEarlier ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            </div>
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              data-testid="priority-dm-message"
              className={`w-fit max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${
                message.sender === "creator"
                  ? "ml-auto bg-foreground text-background"
                  : "border border-border bg-card text-foreground"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{message.body}</p>
              <time className="mt-1 block text-[10px] opacity-55">
                {formatConversationTime(message.createdAt)}
              </time>
            </article>
          ))}
        </div>
      </div>

      <div className="border-t border-border p-3 sm:p-4">
        <div className="mx-auto max-w-2xl">
          <p className="mb-2 text-[11px] text-muted-foreground">
            {conversation.freeFollowUpsRemaining} of {conversation.freeFollowUpLimit} free buyer
            follow-ups remain. Extra follow-ups cost{" "}
            {formatCommerceMoney(conversation.followUpPriceAmount, conversation.currency)}.
          </p>
          {conversation.canReply ? (
            <form
              className="flex min-w-0 items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onReply();
              }}
            >
              <label className="min-w-0 flex-1">
                <span className="sr-only">Reply</span>
                <textarea
                  aria-label="Reply"
                  required
                  maxLength={10_000}
                  rows={3}
                  value={draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  placeholder="Write a reply"
                  className="min-h-20 w-full resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className="mt-1 block text-right text-[10px] text-muted-foreground">
                  {draft.length.toLocaleString()} / 10,000
                </span>
              </label>
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                aria-label="Send reply"
                className="mb-4 inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-foreground text-background outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </button>
            </form>
          ) : (
            <p className="rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground">
              {conversation.readOnlyReason || "This conversation is read-only."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function formatConversationTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
