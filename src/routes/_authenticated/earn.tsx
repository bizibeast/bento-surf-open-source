/* eslint-disable @typescript-eslint/no-explicit-any -- Referral tables ship with the paired migration. */
import { useEffect, useState, type ComponentType } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  Pencil,
  WalletCards,
} from "lucide-react";
import QRCode from "qrcode";
import { FaLinkedinIn } from "react-icons/fa";
import { SiInstagram, SiThreads, SiX as SiXLogo } from "react-icons/si";
import { toast } from "sonner";
import { AppHeader } from "@/components/AppHeader";
import { BentoIcon } from "@/components/BentoBrand";
import { formatCommerceMoney } from "@/lib/commerce";
import { micro } from "@/lib/micro-app-ui";
import {
  getEarnOverview,
  requestReferralPayout,
  submitReachReward,
  updateReferralCode,
} from "@/lib/referral.functions";
import { useWebMcpTools } from "@/lib/webmcp";
import { createEarnReachWebMcpTool } from "@/lib/webmcp-earn";

const REACH_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  twitter: SiXLogo,
  linkedin: FaLinkedinIn,
  instagram: SiInstagram,
  threads: SiThreads,
};
const REACH_ICON_COLORS: Record<string, string> = {
  twitter: "#111111",
  linkedin: "#0a66c2",
  instagram: "#e1306c",
  threads: "#111111",
};

export const Route = createFileRoute("/_authenticated/earn")({
  head: () => ({ meta: [{ title: "Earn | bento.surf" }] }),
  loader: ({ context }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["earn-overview"],
      queryFn: () => getEarnOverview(),
    });
  },
  component: EarnPage,
});

function EarnPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["earn-overview"],
    queryFn: () => getEarnOverview(),
    staleTime: 30_000,
  });
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState("");
  const [qr, setQr] = useState("");
  const [postUrl, setPostUrl] = useState("");

  useEffect(() => setCode(data?.account.code ?? ""), [data?.account.code]);
  useEffect(() => {
    if (!data?.referralUrl) return;
    void QRCode.toDataURL(data.referralUrl, { width: 320, margin: 1 }).then(setQr);
  }, [data?.referralUrl]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["earn-overview"] });
  useWebMcpTools([createEarnReachWebMcpTool(refresh)]);
  const codeMutation = useMutation({
    mutationFn: () => updateReferralCode({ data: { code } }),
    onSuccess: () => {
      setEditing(false);
      void refresh();
      toast.success("Referral link updated.");
    },
    onError: (value) =>
      toast.error(value instanceof Error ? value.message : "Link could not be updated."),
  });
  const payout = useMutation({
    mutationFn: (currency: string) => requestReferralPayout({ data: { currency } }),
    onSuccess: () => {
      void refresh();
      toast.success("Payout request sent for founder review.");
    },
    onError: (value) =>
      toast.error(value instanceof Error ? value.message : "Payout could not be requested."),
  });
  const reach = useMutation({
    mutationFn: () => submitReachReward({ data: { postUrl } }),
    onSuccess: () => {
      setPostUrl("");
      void refresh();
      toast.success("Post submitted for verification.");
    },
    onError: (value) =>
      toast.error(value instanceof Error ? value.message : "Post could not be submitted."),
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <LoadError />;
  const primaryCurrency = data.totals.USD ? "USD" : (Object.keys(data.totals)[0] ?? "USD");
  const totals = data.totals[primaryCurrency] ?? { pending: 0, available: 0, paid: 0, lifetime: 0 };
  const conversion = data.clicks ? Math.round((data.referrals / data.clicks) * 1000) / 10 : 0;
  const commissionRate =
    (data.account.commission_rate_bps ?? data.settings.commission_rate_bps) / 100;
  const reachRates = Object.entries(data.settings.reach_rates ?? {});

  return (
    <main className={micro.shell}>
      <AppHeader title="Earn" />
      <div className={`${micro.main} space-y-8 py-6 sm:py-8`}>
        {data.account.status === "suspended" && (
          <div
            className="rounded-xl border border-[#ff7a59]/25 bg-[#fff0ea] px-4 py-3 text-sm text-[#8f3f2b]"
            role="status"
          >
            New referrals and payout requests are paused. Your existing earnings remain visible.
          </div>
        )}

        <header>
          <h1 className="font-ui-display text-2xl text-[#17213a] sm:text-3xl">Your earnings</h1>
          <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <strong className="font-ui-display text-4xl tracking-[-0.04em] text-[#17213a] sm:text-5xl">
              {formatCommerceMoney(totals.lifetime, primaryCurrency)}
            </strong>
            <span className="text-sm text-black/45 sm:text-base">
              / {formatCommerceMoney(totals.paid, primaryCurrency)} paid out
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-black/45">
            <span>{formatCommerceMoney(totals.available, primaryCurrency)} available</span>
            <span>{formatCommerceMoney(totals.pending, primaryCurrency)} pending</span>
          </div>
        </header>

        <section className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-2">
          <div className="flex min-w-0 min-h-[620px] flex-col rounded-2xl border border-black/[0.08] bg-white p-5 shadow-[0_22px_60px_-48px_rgba(23,33,58,0.45)] sm:p-6">
            <div>
              <h2 className="text-base font-semibold text-[#17213a]">Get paid for customers</h2>
              <p className="mt-1 text-sm text-black/55">
                Earn {commissionRate}% of everything your referrals pay.
              </p>
            </div>

            <div className="mt-5 flex min-w-0 overflow-hidden rounded-xl border border-black/[0.09] bg-white">
              {editing ? (
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value.toLowerCase())}
                  className="min-w-0 flex-1 px-4 py-3 text-sm outline-none focus:bg-[#f8faff]"
                  aria-label="Referral code"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate px-4 py-3 font-mono text-sm text-[#17213a]">
                  {data.referralUrl}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  if (editing) codeMutation.mutate();
                  else {
                    void navigator.clipboard.writeText(data.referralUrl);
                    toast.success("Referral link copied.");
                  }
                }}
                disabled={codeMutation.isPending}
                className="inline-flex shrink-0 items-center gap-1.5 border-l border-black/[0.09] px-4 text-sm font-semibold text-[#17213a] transition hover:bg-[#f7f8fb] disabled:opacity-45"
              >
                {editing ? <Check className="size-4" /> : <Copy className="size-4" />}
                {editing ? "Save" : "Copy"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setEditing((value) => !value)}
              className="mt-3 inline-flex w-fit items-center gap-1.5 text-xs text-black/50 transition hover:text-black/75"
            >
              <Pencil className="size-3.5" /> {editing ? "Cancel" : "Customize this link"}
            </button>

            <div className="mx-auto my-7 w-full max-w-[290px]">
              <div className="rounded-2xl bg-[#17213a] p-5 text-white shadow-[0_24px_50px_-28px_rgba(23,33,58,0.8)]">
                <div className="flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold">
                    <BentoIcon className="size-7" /> bento.surf
                  </span>
                  <span className="text-right text-[10px] uppercase tracking-[0.12em] text-white/65">
                    You earn
                    <strong className="block text-lg tracking-normal text-white">
                      {commissionRate}%
                    </strong>
                  </span>
                </div>
                <div className="mt-8 text-[10px] uppercase tracking-[0.12em] text-white/55">
                  Shared by
                </div>
                <div className="mt-1 truncate text-lg font-semibold">@{data.account.code}</div>
                <div className="mt-10 flex justify-center">
                  {qr ? (
                    <img
                      src={qr}
                      alt="QR code for your referral link"
                      className="size-40 rounded-xl border-[9px] border-white bg-white"
                    />
                  ) : (
                    <div className="grid size-40 place-items-center rounded-xl bg-white/10">
                      <LoaderCircle className="size-5 animate-spin" />
                    </div>
                  )}
                </div>
                <div className="mt-3 text-center font-mono text-[10px] text-white/55">
                  {data.account.code}
                </div>
              </div>
              <a
                href={qr}
                download={`bento-referral-${data.account.code}.png`}
                className="mt-3 flex items-center justify-center gap-1.5 text-xs font-medium text-black/50 hover:text-black/75"
              >
                <Download className="size-3.5" /> Download QR code
              </a>
            </div>

            <details className="group mt-auto border-t border-black/[0.07] pt-4">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-black/55">
                Tracked links &amp; referrals
                <ChevronDown className="size-4 transition group-open:rotate-180" />
              </summary>
              <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
                <SmallStat label="Clicks" value={data.clicks} />
                <SmallStat label="Signups" value={data.referrals} />
                <SmallStat label="Customers" value={data.payingCustomers} />
                <SmallStat label="Conversion" value={`${conversion}%`} />
              </div>
            </details>
          </div>

          <div className="flex min-w-0 min-h-[620px] flex-col rounded-2xl border border-black/[0.08] bg-white p-5 shadow-[0_22px_60px_-48px_rgba(23,33,58,0.45)] sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-[#17213a]">Get paid for reach</h2>
                <p className="mt-1 text-sm text-black/55">
                  Post about Bento, include your link, and earn on verified views.
                </p>
              </div>
              <span className="rounded-lg bg-[#eef2ff] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#5d63d8]">
                Beta
              </span>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {reachRates.map(([provider, amount]) => (
                <span
                  key={provider}
                  className="inline-flex items-center gap-2 rounded-lg border border-black/[0.08] bg-[#fafafa] px-2.5 py-1.5 text-xs text-[#17213a]"
                  title={provider === "twitter" ? "X" : provider}
                >
                  {(() => {
                    const Icon = REACH_ICONS[provider];
                    return Icon ? (
                      <span style={{ color: REACH_ICON_COLORS[provider] }}>
                        <Icon className="size-3.5" />
                      </span>
                    ) : null;
                  })()}
                  {formatCommerceMoney(Number(amount), "USD")}
                </span>
              ))}
              <span className="self-center text-[11px] text-black/40">per 10k views</span>
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                reach.mutate();
              }}
              className="mt-5 space-y-3"
            >
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <label>
                  <span className="mb-1.5 block text-xs font-medium text-black/55">Post link</span>
                  <input
                    type="url"
                    value={postUrl}
                    onChange={(event) => setPostUrl(event.target.value)}
                    placeholder="Paste a published post link"
                    className="w-full rounded-xl border border-black/[0.09] bg-white px-3.5 py-3 text-sm outline-none placeholder:text-black/30 focus:border-[#3478f6]/45"
                    required
                  />
                </label>
                <button
                  disabled={reach.isPending}
                  className="mt-auto inline-flex h-[46px] items-center justify-center gap-2 rounded-xl bg-[#17213a] px-5 text-sm font-semibold text-white transition hover:bg-[#263252] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {reach.isPending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <ExternalLink className="size-4" />
                  )}
                  Submit
                </button>
              </div>
            </form>

            <div className="mt-6 border-t border-black/[0.07]">
              {data.reach.length ? (
                data.reach.slice(0, 6).map((item: any) => (
                  <div
                    key={item.id}
                    className="flex items-start justify-between gap-4 border-b border-black/[0.06] py-3 text-sm last:border-0"
                  >
                    <div className="min-w-0">
                      <a
                        href={item.canonical_post_url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate font-medium capitalize text-[#17213a] hover:underline"
                      >
                        {item.provider} post
                      </a>
                      {item.rejection_reason && (
                        <p className="mt-0.5 text-xs text-[#b84b31]">{item.rejection_reason}</p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs capitalize text-black/40">
                      {statusLabel(item.status)}
                      {item.final_views != null && ` · ${item.final_views.toLocaleString()} views`}
                    </span>
                  </div>
                ))
              ) : (
                <div className="py-14 text-center">
                  <p className="text-sm font-medium text-[#17213a]">No posts submitted yet</p>
                  <p className="mt-1 text-xs text-black/40">Paste your first post link above.</p>
                </div>
              )}
            </div>
            <p className="mt-auto border-t border-black/[0.07] pt-4 text-xs text-black/40">
              Add your referral link to the post. Views are verified after 7 days, up to{" "}
              {formatCommerceMoney(data.settings.reach_cap, "USD")} per post.
            </p>
          </div>
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-black/55">
              Earnings
            </h2>
            <button
              type="button"
              onClick={() => payout.mutate(primaryCurrency)}
              disabled={payout.isPending || totals.available <= 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.09] bg-white px-3 py-2 text-xs font-semibold text-[#17213a] shadow-sm transition hover:bg-[#f7f8fb] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {payout.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <WalletCards className="size-3.5" />
              )}
              Request payout
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_22px_60px_-48px_rgba(23,33,58,0.45)]">
            {data.commissions.length || data.payouts.length ? (
              <div className="divide-y divide-black/[0.06]">
                {data.commissions.slice(0, 10).map((item: any) => (
                  <LedgerRow
                    key={item.id}
                    title="Customer commission"
                    detail={statusLabel(item.status)}
                    value={formatCommerceMoney(item.amount - item.reversed_amount, item.currency)}
                  />
                ))}
                {data.payouts.slice(0, 5).map((item: any) => (
                  <LedgerRow
                    key={item.id}
                    title="Payout"
                    detail={statusLabel(item.status)}
                    value={`−${formatCommerceMoney(item.amount, item.currency)}`}
                  />
                ))}
              </div>
            ) : (
              <div className="grid min-h-44 place-items-center px-5 text-center">
                <div>
                  <p className="text-sm font-medium text-[#17213a]">No earnings yet</p>
                  <p className="mt-1 text-xs text-black/40">Share your link or submit a post.</p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function SmallStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-lg font-semibold text-[#17213a]">{value}</div>
      <div className="mt-0.5 text-xs text-black/40">{label}</div>
    </div>
  );
}

function LedgerRow({ title, detail, value }: { title: string; detail: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4 text-sm sm:px-6">
      <div>
        <div className="font-medium text-[#17213a]">{title}</div>
        <div className="mt-0.5 text-xs capitalize text-black/40">{detail}</div>
      </div>
      <span className="font-semibold text-[#17213a]">{value}</span>
    </div>
  );
}

function statusLabel(value: string) {
  return value.replaceAll("_", " ");
}

function Loading() {
  return (
    <main className={micro.shell}>
      <AppHeader title="Earn" />
      <div className={`${micro.main} flex min-h-64 items-center justify-center`}>
        <LoaderCircle className="size-6 animate-spin text-[#3478f6]" />
      </div>
    </main>
  );
}

function LoadError() {
  return (
    <main className={micro.shell}>
      <AppHeader title="Earn" />
      <div className={`${micro.main} py-10 text-center text-sm text-black/50`}>
        Earn could not be loaded. Please refresh.
      </div>
    </main>
  );
}
