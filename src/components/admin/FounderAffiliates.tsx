/* eslint-disable @typescript-eslint/no-explicit-any -- Referral tables ship with the paired migration. */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Pause, Play, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { formatCommerceMoney } from "@/lib/commerce";
import {
  getFounderAffiliates,
  reviewReachSubmission,
  setReferralAccountRate,
  setReferralAccountStatus,
  transitionReferralPayout,
  updateReferralSettings,
} from "@/lib/referral-admin.functions";

const button =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#17213a]/10 bg-white px-3 py-2 text-xs font-semibold shadow-sm transition hover:-translate-y-0.5 disabled:opacity-45";

export function FounderAffiliates() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["founder-affiliates"],
    queryFn: () => getFounderAffiliates(),
    refetchInterval: 60_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["founder-affiliates"] });
  const account = useMutation({
    mutationFn: (input: { accountId: string; status: "active" | "suspended" }) =>
      setReferralAccountStatus({ data: input }),
    onSuccess: () => {
      void refresh();
      toast.success("Affiliate account updated.");
    },
    onError: mutationError,
  });
  const rate = useMutation({
    mutationFn: (input: { accountId: string; commissionRateBps: number | null }) =>
      setReferralAccountRate({ data: input }),
    onSuccess: () => {
      void refresh();
      toast.success("Future commission rate updated.");
    },
    onError: mutationError,
  });
  const payout = useMutation({
    mutationFn: (input: {
      payoutId: string;
      status: "approved" | "processing" | "paid" | "rejected" | "failed";
      reference?: string;
    }) => transitionReferralPayout({ data: input }),
    onSuccess: () => {
      void refresh();
      toast.success("Payout updated.");
    },
    onError: mutationError,
  });
  const reach = useMutation({
    mutationFn: (input: {
      submissionId: string;
      decision: "approved" | "rejected";
      reason?: string;
    }) => reviewReachSubmission({ data: input }),
    onSuccess: () => {
      void refresh();
      toast.success("Reach reward reviewed.");
    },
    onError: mutationError,
  });

  if (isLoading)
    return (
      <div className="grid min-h-72 place-items-center">
        <LoaderCircle className="size-6 animate-spin" />
      </div>
    );
  if (error || !data)
    return (
      <div className="rounded-2xl bg-white p-8 text-center text-sm shadow-sm">
        Affiliate data could not be loaded.{" "}
        <button className="ml-2 underline" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  const currency = Object.keys(data.totals)[0] ?? "USD";
  const totals = data.totals[currency] ?? { pending: 0, available: 0, paid: 0, reversed: 0 };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className={button} onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FounderMetric label="Tracked clicks" value={data.clicks.toLocaleString()} />
        <FounderMetric label="Attributed signups" value={data.referrals.toLocaleString()} />
        <FounderMetric label="Paying customers" value={data.customers.toLocaleString()} />
        <FounderMetric label="Available" value={formatCommerceMoney(totals.available, currency)} />
      </section>
      <SettingsCard settings={data.settings} onSaved={refresh} />
      <section className="grid gap-4 lg:grid-cols-2">
        <QueueCard title="Payout queue" empty="No payouts need attention.">
          {data.payouts
            .filter((item: any) => !["paid", "rejected", "failed"].includes(item.status))
            .map((item: any) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] py-3 last:border-0"
              >
                <div>
                  <strong className="text-sm">
                    {formatCommerceMoney(item.amount, item.currency)}
                  </strong>
                  <div className="text-xs capitalize text-black/40">{item.status}</div>
                </div>
                <PayoutActions
                  item={item}
                  pending={payout.isPending}
                  act={(status, reference) =>
                    payout.mutate({ payoutId: item.id, status, reference })
                  }
                />
              </div>
            ))}
        </QueueCard>
        <QueueCard title="Reach review" empty="No posts need review.">
          {data.reach
            .filter((item: any) => ["review", "verifying", "measuring"].includes(item.status))
            .map((item: any) => (
              <div key={item.id} className="border-b border-black/[0.06] py-3 last:border-0">
                <a
                  href={item.canonical_post_url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-sm font-semibold underline decoration-black/15"
                >
                  {item.provider} · {item.final_views?.toLocaleString() ?? "checking"} views
                </a>
                <div className="mt-2 flex gap-2">
                  <button
                    className={button}
                    disabled={reach.isPending || item.reward_amount == null}
                    onClick={() => reach.mutate({ submissionId: item.id, decision: "approved" })}
                  >
                    <Check className="size-3.5" /> Approve
                  </button>
                  <button
                    className={button}
                    disabled={reach.isPending}
                    onClick={() =>
                      reach.mutate({
                        submissionId: item.id,
                        decision: "rejected",
                        reason: "Not eligible after founder review.",
                      })
                    }
                  >
                    <X className="size-3.5" /> Reject
                  </button>
                </div>
              </div>
            ))}
        </QueueCard>
      </section>
      <QueueCard title="Affiliates" empty="No creator affiliate accounts yet.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs text-black/40">
              <tr>
                <th className="pb-3">Creator</th>
                <th>Code</th>
                <th>Clicks</th>
                <th>Repeat clicks</th>
                <th>Customers</th>
                <th>Earnings</th>
                <th>Rate</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/[0.06]">
              {data.affiliates.map((item: any) => (
                <tr key={item.id}>
                  <td className="py-3 font-semibold">
                    {item.displayName || item.username}
                    <div className="text-xs font-normal text-black/40">@{item.username}</div>
                  </td>
                  <td>{item.code}</td>
                  <td>{item.clicks}</td>
                  <td className={item.repeatClicks ? "font-semibold text-amber-700" : ""}>
                    {item.repeatClicks || "None"}
                  </td>
                  <td>{item.customers}</td>
                  <td>{formatCommerceMoney(item.earnings, item.currency)}</td>
                  <td>
                    <button
                      className={button}
                      disabled={rate.isPending}
                      onClick={() => {
                        const value = window.prompt(
                          "Commission rate in basis points. Leave blank to use the program default.",
                          item.commission_rate_bps?.toString() ?? "",
                        );
                        if (value !== null)
                          rate.mutate({
                            accountId: item.id,
                            commissionRateBps: value.trim() ? Number(value) : null,
                          });
                      }}
                    >
                      {item.commission_rate_bps ?? data.settings.commission_rate_bps} bps
                    </button>
                  </td>
                  <td>
                    <button
                      className={button}
                      disabled={account.isPending}
                      onClick={() =>
                        account.mutate({
                          accountId: item.id,
                          status: item.status === "active" ? "suspended" : "active",
                        })
                      }
                    >
                      {item.status === "active" ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {item.status}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueueCard>
    </div>
  );
}

function FounderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white bg-white/90 p-5 shadow-sm">
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-black/35">
        {label}
      </span>
      <div className="mt-2 font-ui-display text-3xl">{value}</div>
    </div>
  );
}
function QueueCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const present = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <section className="rounded-2xl border border-white bg-white/90 p-5 shadow-sm">
      <h2 className="font-ui-display text-2xl">{title}</h2>
      <div className="mt-3">
        {present ? children : <p className="py-7 text-center text-sm text-black/40">{empty}</p>}
      </div>
    </section>
  );
}

function PayoutActions({
  item,
  pending,
  act,
}: {
  item: any;
  pending: boolean;
  act: (
    status: "approved" | "processing" | "paid" | "rejected" | "failed",
    reference?: string,
  ) => void;
}) {
  if (item.status === "requested")
    return (
      <div className="flex gap-2">
        <button className={button} disabled={pending} onClick={() => act("approved")}>
          <Check className="size-3.5" /> Approve
        </button>
        <button className={button} disabled={pending} onClick={() => act("rejected")}>
          <X className="size-3.5" /> Reject
        </button>
      </div>
    );
  if (item.status === "approved")
    return (
      <button className={button} disabled={pending} onClick={() => act("processing")}>
        Start transfer
      </button>
    );
  return (
    <div className="flex gap-2">
      <button
        className={button}
        disabled={pending}
        onClick={() => {
          const reference = window.prompt("Transfer reference");
          if (reference) act("paid", reference);
        }}
      >
        Mark paid
      </button>
      <button className={button} disabled={pending} onClick={() => act("failed")}>
        Failed
      </button>
    </div>
  );
}

function SettingsCard({ settings, onSaved }: { settings: any; onSaved: () => void }) {
  const values = (value: any) => ({
    enabled: value.enabled,
    commissionRateBps: value.commission_rate_bps,
    attributionWindowDays: value.attribution_window_days,
    commissionHoldDays: value.commission_hold_days,
    payoutMinimumUsd: value.payout_minimums?.USD ?? 5000,
    reachCap: value.reach_cap,
    reachRates: {
      twitter: value.reach_rates?.twitter ?? 1000,
      linkedin: value.reach_rates?.linkedin ?? 2500,
      instagram: value.reach_rates?.instagram ?? 500,
      threads: value.reach_rates?.threads ?? 500,
    },
  });
  const [form, setForm] = useState(values(settings));
  useEffect(() => setForm(values(settings)), [settings]);
  const save = useMutation({
    mutationFn: () => updateReferralSettings({ data: form }),
    onSuccess: () => {
      onSaved();
      toast.success("Future referral policy updated.");
    },
    onError: mutationError,
  });
  return (
    <section className="rounded-2xl border border-white bg-white/90 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-ui-display text-2xl">Program policy</h2>
          <p className="text-xs text-black/40">Changes apply to future ledger entries only.</p>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />{" "}
          Enabled
        </label>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Setting
          label="Commission bps"
          value={form.commissionRateBps}
          onChange={(commissionRateBps) => setForm({ ...form, commissionRateBps })}
        />
        <Setting
          label="Attribution days"
          value={form.attributionWindowDays}
          onChange={(attributionWindowDays) => setForm({ ...form, attributionWindowDays })}
        />
        <Setting
          label="Hold days"
          value={form.commissionHoldDays}
          onChange={(commissionHoldDays) => setForm({ ...form, commissionHoldDays })}
        />
        <Setting
          label="Min payout cents"
          value={form.payoutMinimumUsd}
          onChange={(payoutMinimumUsd) => setForm({ ...form, payoutMinimumUsd })}
        />
        <Setting
          label="Reach cap cents"
          value={form.reachCap}
          onChange={(reachCap) => setForm({ ...form, reachCap })}
        />
        <Setting
          label="X / 10k cents"
          value={form.reachRates.twitter}
          onChange={(twitter) => setForm({ ...form, reachRates: { ...form.reachRates, twitter } })}
        />
        <Setting
          label="LinkedIn / 10k"
          value={form.reachRates.linkedin}
          onChange={(linkedin) =>
            setForm({ ...form, reachRates: { ...form.reachRates, linkedin } })
          }
        />
        <Setting
          label="Instagram / 10k"
          value={form.reachRates.instagram}
          onChange={(instagram) =>
            setForm({ ...form, reachRates: { ...form.reachRates, instagram } })
          }
        />
        <Setting
          label="Threads / 10k"
          value={form.reachRates.threads}
          onChange={(threads) => setForm({ ...form, reachRates: { ...form.reachRates, threads } })}
        />
      </div>
      <button
        className={`${button} mt-4 bg-[#17213a] text-white`}
        onClick={() => save.mutate()}
        disabled={save.isPending}
      >
        {save.isPending ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5" />
        )}{" "}
        Save policy
      </button>
    </section>
  );
}
function Setting({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="text-xs font-semibold text-black/45">
      {label}
      <input
        type="number"
        min="0"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1.5 w-full rounded-lg border border-black/10 px-3 py-2 text-sm text-black outline-none"
      />
    </label>
  );
}
function mutationError(error: unknown) {
  toast.error(error instanceof Error ? error.message : "That change could not be saved.");
}
