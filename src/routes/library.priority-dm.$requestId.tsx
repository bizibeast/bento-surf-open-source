import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, LockKeyhole, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BentoFullLogo } from "@/components/BentoBrand";
import { formatCommerceMoney } from "@/lib/commerce";
import { createCommerceCheckout } from "@/lib/commerce.functions";
import { getCustomerLibrary } from "@/lib/customer-library.functions";
import { getCustomerPriorityDm, sendCustomerPriorityDmMessage } from "@/lib/priority-dm.functions";
import type { PriorityDmConversationView } from "@/lib/priority-dm.server";
import { safeNavigationHref } from "@/lib/safe-url";
import { LibraryLogin } from "./library.index";

type BuyerConversationState =
  | { state: "signed-out" }
  | { state: "unavailable" }
  | {
      state: "ready";
      customer: { email: string; name: string | null };
      conversation: PriorityDmConversationView;
    };

const queryKey = (requestId: string) => ["customer-priority-dm", requestId] as const;

async function loadBuyerConversation(requestId: string): Promise<BuyerConversationState> {
  const library = await getCustomerLibrary();
  if (!library) return { state: "signed-out" };
  try {
    return {
      state: "ready",
      customer: library.customer,
      conversation: await getCustomerPriorityDm({ data: { requestId } }),
    };
  } catch {
    return { state: "unavailable" };
  }
}

export const Route = createFileRoute("/library/priority-dm/$requestId")({
  head: () => ({
    meta: [
      { title: "Priority DM conversation | bento.surf" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData({
      queryKey: queryKey(params.requestId),
      queryFn: () => loadBuyerConversation(params.requestId),
      staleTime: 30_000,
    }),
  component: BuyerPriorityDmPage,
});

function BuyerPriorityDmPage() {
  const { requestId } = Route.useParams();
  const initial = Route.useLoaderData() as BuyerConversationState;
  const thread = useQuery({
    queryKey: queryKey(requestId),
    queryFn: async (): Promise<BuyerConversationState> => {
      if (initial.state !== "ready") return initial;
      try {
        return {
          ...initial,
          conversation: await getCustomerPriorityDm({ data: { requestId } }),
        };
      } catch {
        return { state: "unavailable" };
      }
    },
    initialData: initial,
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.state === "ready" ? 30_000 : false),
    refetchIntervalInBackground: false,
  });
  const data = thread.data;
  const returnTo = `/library/priority-dm/${requestId}`;

  if (data.state === "signed-out") return <LibraryLogin returnTo={returnTo} />;
  if (data.state === "unavailable") return <UnavailableConversation />;
  return <BuyerConversation data={data} />;
}

function BuyerConversation({
  data,
}: {
  data: Extract<BuyerConversationState, { state: "ready" }>;
}) {
  const { conversation, customer } = data;
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: (input: { requestId: string; body: string }) =>
      sendCustomerPriorityDmMessage({
        data: input,
      }),
    onSuccess: async (_, input) => {
      setBody((current) => (current.trim() === input.body ? "" : current));
      await queryClient.invalidateQueries({ queryKey: queryKey(input.requestId) });
      toast.success("Reply sent");
    },
    onError: async (error, input) => {
      await queryClient.invalidateQueries({ queryKey: queryKey(input.requestId) });
      toast.error(error instanceof Error ? error.message : "Reply could not be sent");
    },
  });
  const checkout = useMutation({
    mutationFn: (message: string) =>
      createCommerceCheckout({
        data: {
          productId: conversation.productId,
          priorityDmRequestId: conversation.id,
          email: customer.email,
          name: customer.name || undefined,
          recordingAddon: false,
          answers: { priority_message: message },
          attribution: {},
        },
      }),
    onSuccess: ({ url }) => {
      const destination = safeNavigationHref(url);
      if (!destination) {
        toast.error("Checkout returned an invalid destination.");
        return;
      }
      window.location.assign(destination);
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Checkout could not start"),
  });
  const messages = [...conversation.messages].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const included = conversation.freeFollowUpsRemaining > 0;
  const pending = send.isPending || checkout.isPending;

  return (
    <div className="min-h-screen overflow-x-clip bg-[#f4f6fb] px-3 py-4 text-[#17213a] sm:px-6 sm:py-8">
      <main className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-white bg-white shadow-[0_30px_100px_-65px_rgba(23,33,58,.7)] sm:min-h-[calc(100vh-4rem)] sm:rounded-[36px]">
        <header className="flex min-w-0 items-center gap-3 border-b border-black/[0.06] px-4 py-4 sm:px-6">
          <Link
            to="/library"
            aria-label="Back to customer library"
            className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-[#f4f6fb]"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{conversation.creatorName}</h1>
            <p className="truncate text-xs text-[#17213a]/45">{conversation.productTitle}</p>
          </div>
          <BentoFullLogo className="ml-auto hidden h-7 w-auto sm:block" />
        </header>

        <section
          role="log"
          aria-label={`Conversation with ${conversation.creatorName}`}
          aria-live="polite"
          className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8fc] px-3 py-5 sm:px-6"
        >
          <div className="mx-auto max-w-2xl space-y-3">
            {messages.map((message) => (
              <article
                key={message.id}
                data-testid="priority-dm-message"
                className={`w-fit max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${
                  message.sender === "buyer"
                    ? "ml-auto bg-[#17213a] text-white"
                    : "border border-black/[0.06] bg-white"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
                <time className="mt-1 block text-[10px] opacity-55">
                  {formatConversationTime(message.createdAt)}
                </time>
              </article>
            ))}
          </div>
        </section>

        <footer className="border-t border-black/[0.06] p-3 sm:p-5">
          <div className="mx-auto max-w-2xl">
            {conversation.canReply ? (
              <>
                <p className="mb-2 text-[11px] text-[#17213a]/48">
                  {included
                    ? `${conversation.freeFollowUpsRemaining} free ${conversation.freeFollowUpsRemaining === 1 ? "reply" : "replies"} remaining`
                    : `Replies cost ${formatCommerceMoney(conversation.followUpPriceAmount, conversation.currency)}`}
                </p>
                <form
                  className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const message = body.trim();
                    if (!message) return;
                    if (included) send.mutate({ requestId: conversation.id, body: message });
                    else checkout.mutate(message);
                  }}
                >
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">Reply</span>
                    <textarea
                      aria-label="Reply"
                      rows={3}
                      maxLength={10_000}
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                      className="min-h-20 w-full resize-y rounded-2xl border border-black/[0.08] bg-[#f7f8fc] px-4 py-3 text-sm outline-none focus:border-[#3478f6]/45 focus:ring-4 focus:ring-[#3478f6]/10"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={pending || !body.trim()}
                    aria-label={
                      included
                        ? "Send reply"
                        : `Pay ${formatCommerceMoney(conversation.followUpPriceAmount, conversation.currency)} to reply`
                    }
                    className="inline-flex min-h-12 w-full shrink-0 items-center justify-center gap-2 rounded-2xl bg-[#3478f6] px-4 text-xs font-semibold text-white disabled:opacity-45 sm:mb-1 sm:w-auto sm:px-5"
                  >
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    <span>
                      {included
                        ? "Send reply"
                        : `Pay ${formatCommerceMoney(conversation.followUpPriceAmount, conversation.currency)} to reply`}
                    </span>
                  </button>
                </form>
              </>
            ) : (
              <p className="rounded-2xl bg-[#f4f6fb] px-4 py-3 text-sm text-[#17213a]/55">
                {conversation.readOnlyReason || "This conversation is read-only."}
              </p>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}

function UnavailableConversation() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f4f6fb] px-4 text-[#17213a]">
      <section className="w-full max-w-md rounded-[32px] border border-black/[0.06] bg-white p-7 text-center shadow-[0_30px_100px_-65px_rgba(23,33,58,.7)] sm:p-9">
        <span className="mx-auto flex size-14 items-center justify-center rounded-[20px] bg-[#dceaff] text-[#3478f6]">
          <LockKeyhole className="size-6" />
        </span>
        <h1 className="mt-5 font-display text-4xl">This conversation is unavailable.</h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/48">
          Sign in with the checkout email that owns this conversation, or open your customer library
          to find an available purchase.
        </p>
        <Link
          to="/library"
          className="mt-6 inline-flex rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
        >
          Open customer library
        </Link>
      </section>
    </main>
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
