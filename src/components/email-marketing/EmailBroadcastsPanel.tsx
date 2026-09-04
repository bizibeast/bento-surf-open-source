import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type {
  CommerceAudienceCampaignRecord,
  CommerceAudienceContactRecord,
  CommerceAudienceListRecord,
} from "@/lib/commerce";
import {
  deleteAudienceCampaign,
  saveAudienceCampaign,
  sendAudienceCampaign,
  sendAudienceCampaignTest,
} from "@/lib/commerce-growth.functions";
import { NewsletterEditor, type NewsletterIssueRecord } from "./NewsletterEditor";

export function EmailBroadcastsPanel({
  publicationId,
  publicationName = "this publication",
  campaigns,
  lists,
  contacts,
  listMembers = [],
  recipientCounts,
  locked,
  onRefresh,
}: {
  publicationId: string;
  publicationName?: string;
  campaigns: CommerceAudienceCampaignRecord[];
  lists: CommerceAudienceListRecord[];
  contacts: CommerceAudienceContactRecord[];
  listMembers?: Array<{ list_id: string; contact_id: string }>;
  recipientCounts?: Record<string, number>;
  locked: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [writerOpen, setWriterOpen] = useState(false);
  const selected = campaigns.find((campaign) => campaign.id === selectedId);
  const [listId, setListId] = useState("");
  const [postalAddress, setPostalAddress] = useState("");
  const [scheduleAt, setScheduleAt] = useState<Record<string, string>>({});
  const targetCount = (campaignListId: string | null) => {
    const authoritative = recipientCounts?.[campaignListId ?? "all"];
    if (authoritative !== undefined) return authoritative;
    const subscribed = contacts.filter((contact) => contact.marketing_status === "subscribed");
    if (!campaignListId) return subscribed.length;
    const members = new Set(
      listMembers
        .filter((member) => member.list_id === campaignListId)
        .map((member) => member.contact_id),
    );
    return subscribed.filter((contact) => members.has(contact.id)).length;
  };
  const send = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: string; scheduledAt: string | null }) =>
      sendAudienceCampaign({ data: { publicationId, id, scheduledAt } }),
    onSuccess: async (_result, variables) => {
      await onRefresh();
      toast.success(variables.scheduledAt ? "Broadcast scheduled" : "Broadcast queued");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Broadcast could not be sent"),
  });
  const testSend = useMutation({
    mutationFn: (id: string) => sendAudienceCampaignTest({ data: { publicationId, id } }),
    onSuccess: () => toast.success("Test email queued"),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Test email could not be sent"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteAudienceCampaign({ data: { publicationId, id } }),
    onSuccess: async () => {
      setSelectedId(undefined);
      await onRefresh();
      toast.success("Draft deleted");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Draft could not be deleted"),
  });
  const open = (campaign?: CommerceAudienceCampaignRecord) => {
    setSelectedId(campaign?.id);
    setWriterOpen(true);
    setListId(campaign?.list_id ?? "");
    setPostalAddress(campaign?.sender_postal_address ?? "");
  };
  const confirmSend = (campaign: CommerceAudienceCampaignRecord, scheduledAt: string | null) => {
    const recipients = targetCount(campaign.list_id);
    const audience = campaign.list_id
      ? (lists.find((list) => list.id === campaign.list_id)?.name ?? "the selected list")
      : "all subscribed contacts";
    const recipientLabel = recipients
      ? `${recipients} subscribed recipient${recipients === 1 ? "" : "s"} in ${audience}`
      : `the subscribed recipients in ${audience}`;
    if (!window.confirm(`Send ${campaign.name} from ${publicationName} to ${recipientLabel}?`))
      return;
    send.mutate({ id: campaign.id, scheduledAt });
  };
  const editorIssue = selected
    ? ({
        ...selected,
        publication_id: null,
        public_slug: null,
        web_visibility: "private",
        content: selected.content ?? [],
      } as NewsletterIssueRecord)
    : undefined;
  const selectedAudience = listId
    ? (lists.find((list) => list.id === listId)?.name ?? "the selected list")
    : "all subscribed contacts";

  return (
    <section className="rounded-[28px] border border-black/[0.06] bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-ui-display text-2xl">Email broadcasts</h2>
          <p className="mt-1 text-sm text-[#17213a]/48">
            Write with the newsletter editor, test first, then send with one-click unsubscribe.
          </p>
        </div>
        <span className="w-fit rounded-full bg-emerald-50 px-3 py-1.5 text-[10px] font-semibold text-emerald-700">
          {targetCount(null)} subscribed
        </span>
      </div>
      {locked ? (
        <div className="mt-4 flex flex-col gap-3 rounded-2xl bg-[#f6f7fa] p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[#17213a]/55">Email marketing is included with Store.</p>
          <Link
            to="/settings"
            className="inline-flex justify-center rounded-xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white"
          >
            Review plan
          </Link>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[#17213a]/55">Drafts stay private to {publicationName}.</p>
            <button
              type="button"
              onClick={() => open()}
              className="rounded-xl bg-[#17213a] px-4 py-2.5 text-xs font-semibold text-white"
            >
              New broadcast
            </button>
          </div>
          {writerOpen ? (
            <div className="space-y-3 rounded-2xl bg-[#f6f7fa] p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold text-[#17213a]/55">
                  {selected ? `Editing ${selected.name}` : "New broadcast"}
                </p>
                <button
                  type="button"
                  onClick={() => setWriterOpen(false)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-[#17213a]/60"
                >
                  Close writer
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
                  Audience
                  <select
                    value={listId}
                    onChange={(event) => setListId(event.target.value)}
                    className="rounded-xl border border-black/[0.08] px-3 py-2.5 text-sm"
                  >
                    <option value="">All subscribed contacts</option>
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-xs font-semibold text-[#17213a]/60">
                  Sender postal address
                  <input
                    value={postalAddress}
                    maxLength={500}
                    onChange={(event) => setPostalAddress(event.target.value)}
                    className="rounded-xl border border-black/[0.08] px-3 py-2.5 text-sm"
                  />
                </label>
              </div>
              <NewsletterEditor
                key={selected?.id ?? "new-broadcast"}
                mode="broadcast"
                issue={editorIssue}
                publicationName={publicationName}
                audienceLabel={selectedAudience}
                recipientCount={targetCount(listId || null)}
                onSaved={onRefresh}
                saveDocument={(document) =>
                  saveAudienceCampaign({
                    data: {
                      publicationId,
                      ...document,
                      listId: listId || null,
                      postalAddress,
                    },
                  })
                }
                onTestSend={async (id) => {
                  await testSend.mutateAsync(id);
                }}
                onPublish={async ({ id, scheduledAt }) => {
                  await send.mutateAsync({ id, scheduledAt });
                }}
              />
            </div>
          ) : null}
        </div>
      )}
      {campaigns.length ? (
        <div className="mt-5 overflow-x-auto [contain:paint]">
          <table
            aria-label="Broadcasts"
            className="w-full min-w-[680px] border-collapse text-left text-sm"
          >
            <thead className="border-b border-black/[0.08] text-xs text-[#17213a]/48">
              <tr>
                <th className="py-2 pr-4">Broadcast</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => {
                const recipients = targetCount(campaign.list_id);
                return (
                  <tr key={campaign.id} className="border-b border-black/[0.06]">
                    <td className="py-3 pr-4">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{campaign.name}</div>
                          <div className="text-xs text-[#17213a]/48">
                            {recipients} subscribed recipient{recipients === 1 ? "" : "s"}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <span className="rounded-full bg-[#f1f4fa] px-2.5 py-1 text-[10px] capitalize text-[#17213a]/55">
                        {campaign.status}
                      </span>
                    </td>
                    <td className="py-3 text-right">
                      {campaign.status === "draft" || campaign.status === "failed" ? (
                        <div className="grid gap-2 sm:grid-cols-[minmax(180px,1fr)_auto_auto_auto_auto]">
                          <input
                            type="datetime-local"
                            aria-label={`Schedule ${campaign.name}`}
                            value={scheduleAt[campaign.id] ?? ""}
                            onChange={(event) =>
                              setScheduleAt((current) => ({
                                ...current,
                                [campaign.id]: event.target.value,
                              }))
                            }
                            className="min-w-0 rounded-xl border border-black/[0.08] px-3 py-2 text-xs"
                          />
                          <button
                            type="button"
                            disabled={send.isPending || writerOpen || recipients === 0}
                            onClick={() => confirmSend(campaign, null)}
                            className="rounded-xl bg-[#3478f6] px-3 py-2 text-xs font-semibold text-white disabled:opacity-45"
                          >
                            {campaign.status === "failed" ? "Retry now" : "Send now"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              send.isPending ||
                              writerOpen ||
                              !scheduleAt[campaign.id] ||
                              recipients === 0
                            }
                            onClick={() =>
                              confirmSend(campaign, new Date(scheduleAt[campaign.id]).toISOString())
                            }
                            className="rounded-xl border border-black/[0.08] px-3 py-2 text-xs font-semibold disabled:opacity-45"
                          >
                            Schedule
                          </button>
                          <button
                            type="button"
                            disabled={
                              testSend.isPending || writerOpen || campaign.status !== "draft"
                            }
                            onClick={() => testSend.mutate(campaign.id)}
                            className="rounded-xl border border-black/[0.08] px-3 py-2 text-xs font-semibold disabled:opacity-45"
                          >
                            Send test
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${campaign.name}`}
                            disabled={remove.isPending || campaign.status !== "draft"}
                            onClick={() => remove.mutate(campaign.id)}
                            className="flex size-9 items-center justify-center rounded-xl text-red-500"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      ) : null}
                      {campaign.status === "draft" ? (
                        <button
                          type="button"
                          aria-label={`Edit ${campaign.name}`}
                          onClick={() => open(campaign)}
                          className="ml-2 inline-flex size-9 items-center justify-center rounded-xl"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-5 rounded-xl bg-[#f6f7fa] p-4 text-sm text-[#17213a]/55">
          No broadcasts for this publication yet.
        </p>
      )}
    </section>
  );
}
