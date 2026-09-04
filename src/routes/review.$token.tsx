import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BentoBrand } from "@/components/BentoBrand";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Star } from "lucide-react";
import { toast } from "sonner";
import { getBookingReview, submitBookingReview } from "@/lib/booking-review.functions";
import { requireWebMcpUserConfirmation, useWebMcpTools, webMcpResult } from "@/lib/webmcp";

export const Route = createFileRoute("/review/$token")({
  head: () => ({
    meta: [
      { title: "Review your session | bento.surf" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
    ],
  }),
  loader: ({ params }) => getBookingReview({ data: { token: params.token } }),
  component: BookingReviewPage,
});

function BookingReviewPage() {
  const initial = Route.useLoaderData();
  const { token } = Route.useParams();
  const [rating, setRating] = useState(Number(initial?.rating || 0));
  const [body, setBody] = useState(initial?.body || "");
  const [done, setDone] = useState(Boolean(initial?.submittedAt));
  const submit = useMutation({
    mutationFn: () => submitBookingReview({ data: { token, rating, body } }),
    onSuccess: () => setDone(true),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Your review could not be saved."),
  });
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_prepare_booking_review",
        title: "Prepare booking review",
        description:
          "Fills the visible session-review rating and optional feedback. The user still presses Share review.",
        inputSchema: {
          type: "object",
          properties: {
            rating: { type: "integer", minimum: 1, maximum: 5 },
            body: { type: "string", maxLength: 5_000 },
          },
          required: ["rating"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: (input: Record<string, unknown>) => {
          const nextRating = input.rating;
          const nextBody = typeof input.body === "string" ? input.body : "";
          if (!Number.isInteger(nextRating) || Number(nextRating) < 1 || Number(nextRating) > 5) {
            throw new Error("Choose a rating from 1 to 5.");
          }
          if (nextBody.length > 5_000) throw new Error("Keep feedback under 5,000 characters.");
          setRating(Number(nextRating));
          setBody(nextBody);
          return webMcpResult("Prepared the visible booking review for the user to submit.", {
            rating: nextRating,
            body: nextBody,
          });
        },
      },
      {
        name: "bento_submit_booking_review",
        title: "Submit booking review",
        description:
          "Submits a star rating and optional feedback after Bento shows a browser approval dialog.",
        inputSchema: {
          type: "object",
          properties: {
            rating: { type: "integer", minimum: 1, maximum: 5 },
            body: { type: "string", maxLength: 5_000 },
          },
          required: ["rating"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) => {
          const nextRating = input.rating;
          const nextBody = typeof input.body === "string" ? input.body : "";
          if (!Number.isInteger(nextRating) || Number(nextRating) < 1 || Number(nextRating) > 5) {
            throw new Error("Choose a rating from 1 to 5.");
          }
          if (nextBody.length > 5_000) throw new Error("Keep feedback under 5,000 characters.");
          await requireWebMcpUserConfirmation("Submit booking review", {
            rating: nextRating,
            body: nextBody,
          });
          signal.throwIfAborted();
          await submitBookingReview({
            data: { token, rating: Number(nextRating), body: nextBody },
          });
          signal.throwIfAborted();
          setRating(Number(nextRating));
          setBody(nextBody);
          setDone(true);
          return webMcpResult("Submitted the booking review.", {
            rating: nextRating,
            submitted: true,
          });
        },
      },
    ],
    [token],
  );
  useWebMcpTools(initial && !done ? webMcpTools : []);

  if (!initial) {
    return (
      <ReviewShell>
        <h1 className="font-display text-4xl">This review link has expired.</h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/55">
          Ask the creator for help if you still need to share feedback.
        </p>
      </ReviewShell>
    );
  }
  if (done) {
    return (
      <ReviewShell>
        <CheckCircle2 className="size-12 text-emerald-500" />
        <h1 className="mt-5 font-display text-4xl">Thank you.</h1>
        <p className="mt-3 text-sm leading-6 text-[#17213a]/55">
          Your feedback was shared with the creator.
        </p>
        <Link
          to="/"
          className="mt-7 inline-flex rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
        >
          <BentoBrand iconClassName="size-5" textClassName="text-white" />
        </Link>
      </ReviewShell>
    );
  }

  return (
    <ReviewShell>
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3478f6]">
        Session review
      </div>
      <h1 className="mt-2 font-display text-4xl">How was {initial.productTitle}?</h1>
      <p className="mt-3 text-sm leading-6 text-[#17213a]/55">
        Your honest feedback helps this creator improve their sessions.
      </p>
      <form
        className="mt-7 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!rating) {
            toast.error("Choose a star rating first.");
            return;
          }
          submit.mutate();
        }}
      >
        <div className="flex gap-2" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              aria-label={`${value} star${value === 1 ? "" : "s"}`}
              onClick={() => setRating(value)}
              className="rounded-xl p-1.5 transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#3478f6]/20"
            >
              <Star
                className={`size-8 ${value <= rating ? "fill-[#ffc928] text-[#ffc928]" : "text-[#17213a]/18"}`}
              />
            </button>
          ))}
        </div>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={5_000}
          placeholder="What worked well? What could be better? (optional)"
          className="min-h-32 w-full rounded-2xl border border-black/[0.08] bg-[#f8faff] px-4 py-3.5 text-sm outline-none transition focus:border-[#3478f6]/45 focus:ring-4 focus:ring-[#3478f6]/10"
        />
        <button
          type="submit"
          disabled={submit.isPending}
          className="inline-flex w-full items-center justify-center rounded-2xl bg-[#17213a] px-5 py-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : "Share review"}
        </button>
      </form>
    </ReviewShell>
  );
}

function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f7f8fc] px-4 py-10 text-[#17213a]">
      <div className="pointer-events-none absolute -left-24 -top-20 size-80 rounded-full bg-[#dceaff] blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 right-[-5rem] size-96 rounded-full bg-[#ffc928]/25 blur-3xl" />
      <section className="relative w-full max-w-xl rounded-[34px] border border-white/80 bg-white/90 p-7 shadow-[0_35px_100px_-55px_rgba(23,33,58,.65)] backdrop-blur-xl sm:p-10">
        {children}
      </section>
    </main>
  );
}
