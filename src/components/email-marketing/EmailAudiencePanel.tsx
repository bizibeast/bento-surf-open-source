import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  archiveAudienceContacts,
  createAudienceList,
  deleteAudienceList,
  getPublicationAudience,
  setAudienceListMember,
  unsubscribePublicationSubscribers,
} from "@/lib/commerce-growth.functions";
import type { CommerceAudienceContactRecord, CommerceAudienceListRecord } from "@/lib/commerce";
import { SubscriberImportDialog } from "./SubscriberImportDialog";

type AudienceContactUsage = {
  plan: "free" | "store" | "creator";
  limit: number;
  subscribed: number;
  remaining: number;
  overLimit: boolean;
};

type PublicationSubscriber = CommerceAudienceContactRecord & {
  subscription_id: string | null;
  subscription_status: "pending" | "subscribed" | "unsubscribed" | "not_subscribed";
  email_enabled: boolean;
  source: string;
  joined_at: string;
  paid_access: boolean;
};

type PublicationList = CommerceAudienceListRecord & { publication_id?: string | null };
type Cursor = { joinedAt: string; id: string };
type AudiencePage = {
  subscribers: PublicationSubscriber[];
  contactUsage: AudienceContactUsage;
  nextCursor: Cursor | null;
};

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-[#3478f6] focus-visible:ring-offset-2";

export function EmailAudiencePanel({
  publication,
  lists: allLists,
  listMembers,
  contactUsage,
  locked,
  onRefresh,
}: {
  publication: { id: string; title: string };
  lists: PublicationList[];
  listMembers: Array<{ list_id: string; contact_id: string }>;
  contactUsage?: AudienceContactUsage;
  locked: boolean;
  onRefresh: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const lists = allLists.filter((list) => list.publication_id === publication.id);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "pending" | "subscribed" | "unsubscribed">("all");
  const [listId, setListId] = useState("");
  const [joinedFrom, setJoinedFrom] = useState("");
  const [joinedTo, setJoinedTo] = useState("");
  const [cursor, setCursor] = useState<Cursor>();
  const [previousCursors, setPreviousCursors] = useState<Array<Cursor | undefined>>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const audience = useQuery({
    queryKey: [
      "publication-audience",
      publication.id,
      query,
      status,
      listId,
      joinedFrom,
      joinedTo,
      sortDirection,
      cursor?.joinedAt,
      cursor?.id,
    ],
    queryFn: () =>
      getPublicationAudience({
        data: {
          publicationId: publication.id,
          query,
          status,
          listId: listId || undefined,
          joinedFrom: joinedFrom || undefined,
          joinedTo: joinedTo || undefined,
          sortDirection,
          cursor,
        },
      }) as Promise<AudiencePage>,
  });

  const subscribers = audience.data?.subscribers ?? [];
  const usage = audience.data?.contactUsage ??
    contactUsage ?? {
      plan: "free" as const,
      limit: 0,
      subscribed: 0,
      remaining: 0,
      overLimit: false,
    };
  const selected = subscribers.filter((subscriber) => selectedIds.includes(subscriber.id));
  const resetCursor = () => {
    setCursor(undefined);
    setPreviousCursors([]);
    setSelectedIds([]);
  };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["publication-audience", publication.id] }),
      onRefresh(),
    ]);
  };

  const unsubscribe = useMutation({
    mutationFn: (rows: PublicationSubscriber[]) =>
      unsubscribePublicationSubscribers({
        data: {
          publicationId: publication.id,
          subscribers: rows
            .filter(
              (subscriber): subscriber is PublicationSubscriber & { subscription_id: string } =>
                Boolean(subscriber.subscription_id),
            )
            .map((subscriber) => ({
              subscriptionId: subscriber.subscription_id,
              email: subscriber.email,
            })),
        },
      }),
    onSuccess: async ({ unsubscribed }) => {
      setSelectedIds([]);
      await refresh();
      toast.success(
        `${unsubscribed} subscriber${unsubscribed === 1 ? "" : "s"} unsubscribed from ${publication.title}`,
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Subscribers could not be unsubscribed"),
  });
  const archive = useMutation({
    mutationFn: (rows: PublicationSubscriber[]) =>
      archiveAudienceContacts({ data: { contactIds: rows.map((subscriber) => subscriber.id) } }),
    onSuccess: async ({ transitioned }) => {
      setSelectedIds([]);
      await refresh();
      toast.success(`${transitioned} account contact${transitioned === 1 ? "" : "s"} archived`);
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Account contacts could not be archived",
      ),
  });

  const sortHeader = () => (
    <button
      type="button"
      onClick={() => {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
        resetCursor();
      }}
      className={`inline-flex items-center gap-1 rounded ${focusRing}`}
    >
      Joined
      {sortDirection === "asc" ? (
        <ArrowUp className="size-3" aria-hidden="true" />
      ) : (
        <ArrowDown className="size-3" aria-hidden="true" />
      )}
    </button>
  );

  return (
    <div className="space-y-4">
      <section className="rounded-[28px] border border-black/[0.06] bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-ui-display text-2xl">Audience</h2>
            <p className="mt-1 text-sm text-[#17213a]/48">
              {usage.subscribed} / {usage.limit} marketing contacts; customers remain visible below
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <SubscriberImportDialog
              open={importOpen}
              onOpenChange={setImportOpen}
              publication={publication}
              onImported={refresh}
              trigger={
                <button
                  type="button"
                  disabled={locked}
                  className={`rounded-xl bg-[#3478f6] px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45 ${focusRing}`}
                >
                  Import subscribers
                </button>
              }
            />
            <Link
              to="/settings"
              search={{ section: "plan" }}
              className={`rounded-xl border border-black/[0.08] px-4 py-2.5 text-xs font-semibold ${focusRing}`}
            >
              Increase account capacity
            </Link>
          </div>
        </div>
        {locked && (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Upgrade to import or manage subscribers. Existing subscriber records stay visible.
          </p>
        )}
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              resetCursor();
            }}
            placeholder="Search email"
            aria-label="Search subscribers"
            className={`min-w-0 rounded-xl border border-black/[0.08] bg-[#f8faff] px-3 py-2.5 text-sm ${focusRing}`}
          />
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as typeof status);
              resetCursor();
            }}
            aria-label="Subscription status"
            className={`rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm ${focusRing}`}
          >
            <option value="all">All contacts</option>
            <option value="pending">Pending</option>
            <option value="subscribed">Subscribed</option>
            <option value="unsubscribed">Unsubscribed</option>
          </select>
          <select
            value={listId}
            onChange={(event) => {
              setListId(event.target.value);
              resetCursor();
            }}
            aria-label="Subscriber list"
            className={`rounded-xl border border-black/[0.08] bg-white px-3 py-2.5 text-sm ${focusRing}`}
          >
            <option value="">All lists</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 text-xs text-[#17213a]/55">
            Joined after
            <input
              type="date"
              value={joinedFrom}
              onChange={(event) => {
                setJoinedFrom(event.target.value);
                resetCursor();
              }}
              className={`min-w-0 flex-1 bg-transparent py-2.5 text-sm text-[#17213a] ${focusRing}`}
            />
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-black/[0.08] bg-white px-3 text-xs text-[#17213a]/55">
            Joined before
            <input
              type="date"
              value={joinedTo}
              onChange={(event) => {
                setJoinedTo(event.target.value);
                resetCursor();
              }}
              className={`min-w-0 flex-1 bg-transparent py-2.5 text-sm text-[#17213a] ${focusRing}`}
            />
          </label>
        </div>
      </section>

      {selected.length > 0 && !locked && (
        <div
          role="toolbar"
          aria-label="Selected audience contacts"
          className="flex flex-col gap-3 rounded-2xl border border-[#3478f6]/15 bg-[#eef5ff] p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-xs text-[#17213a]/65">
            {selected.length} selected. Unsubscribe affects only {publication.title}; account
            archive removes them from every publication and marketing send.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={
                unsubscribe.isPending || selected.every((subscriber) => !subscriber.subscription_id)
              }
              onClick={() => {
                if (window.confirm(`Unsubscribe ${selected.length} from ${publication.title}?`)) {
                  unsubscribe.mutate(selected.filter((subscriber) => subscriber.subscription_id));
                }
              }}
              className={`rounded-xl bg-[#17213a] px-3 py-2 text-xs font-semibold text-white disabled:opacity-45 ${focusRing}`}
            >
              Unsubscribe newsletter contacts
            </button>
            <button
              type="button"
              disabled={archive.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Archive selected account contacts? This removes them from every publication.",
                  )
                ) {
                  archive.mutate(selected);
                }
              }}
              className={`rounded-xl border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-45 ${focusRing}`}
            >
              Archive account contact{selected.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}

      <section className="overflow-hidden rounded-[28px] border border-black/[0.06] bg-white shadow-sm">
        {audience.isLoading ? (
          <p className="p-8 text-center text-sm text-[#17213a]/50">Loading subscribers…</p>
        ) : audience.isError ? (
          <div className="p-8 text-center" role="alert">
            <p className="text-sm text-red-700">Audience could not be loaded.</p>
            <button
              type="button"
              onClick={() => audience.refetch()}
              className={`mt-3 rounded-xl border border-black/[0.08] px-3 py-2 text-xs font-semibold ${focusRing}`}
            >
              Retry
            </button>
          </div>
        ) : subscribers.length === 0 ? (
          <p className="p-10 text-center text-sm text-[#17213a]/50">
            {query || status !== "all" || listId || joinedFrom || joinedTo
              ? "No audience contacts match these filters."
              : `No audience contacts for ${publication.title} yet.`}
          </p>
        ) : (
          <div className="overflow-x-auto [contain:paint]">
            <table
              className="w-full min-w-[980px] border-collapse"
              aria-label={`${publication.title} audience`}
            >
              <thead>
                <tr className="border-b border-black/[0.06] bg-[#f8faff] text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#17213a]/45">
                  {!locked && (
                    <th className="w-12 px-4 py-3">
                      <span className="sr-only">Select</span>
                    </th>
                  )}
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Lists</th>
                  <th className="px-4 py-3">Source</th>
                  <th
                    className="px-4 py-3"
                    aria-sort={sortDirection === "asc" ? "ascending" : "descending"}
                  >
                    {sortHeader()}
                  </th>
                  <th className="px-4 py-3">Paid access</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {subscribers.map((subscriber) => {
                  return (
                    <tr key={subscriber.id} className="border-b border-black/[0.05] last:border-0">
                      {!locked && (
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${subscriber.name || subscriber.email}`}
                            checked={selectedIds.includes(subscriber.id)}
                            onChange={(event) =>
                              setSelectedIds((ids) =>
                                event.target.checked
                                  ? [...ids, subscriber.id]
                                  : ids.filter((id) => id !== subscriber.id),
                              )
                            }
                            className={`size-4 rounded border-black/20 text-[#3478f6] ${focusRing}`}
                          />
                        </td>
                      )}
                      <td
                        className="max-w-56 truncate px-4 py-3 text-sm font-medium"
                        title={subscriber.email}
                      >
                        {subscriber.email}
                      </td>
                      <td
                        className="max-w-40 truncate px-4 py-3 text-sm text-[#17213a]/65"
                        title={subscriber.name ?? ""}
                      >
                        {subscriber.name || "No name"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${statusClass(subscriber.subscription_status)}`}
                        >
                          {subscriber.subscription_status.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td className="max-w-64 px-4 py-3">
                        <AudienceListPicker
                          publicationId={publication.id}
                          contactId={subscriber.id}
                          lists={lists}
                          listMembers={listMembers}
                          locked={locked}
                          onRefresh={refresh}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm capitalize text-[#17213a]/60">
                        {sourceLabel(subscriber.source)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-[#17213a]/60">
                        {new Date(subscriber.joined_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-sm">{subscriber.paid_access ? "Yes" : "No"}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={
                            locked ||
                            unsubscribe.isPending ||
                            !subscriber.subscription_id ||
                            subscriber.subscription_status === "unsubscribed"
                          }
                          onClick={() => unsubscribe.mutate([subscriber])}
                          className={`rounded-lg px-2 py-1 text-xs font-semibold text-[#3478f6] disabled:opacity-40 ${focusRing}`}
                        >
                          {subscriber.subscription_id ? "Unsubscribe" : "Not subscribed"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <nav className="flex items-center justify-between gap-3" aria-label="Subscriber pagination">
        <button
          type="button"
          disabled={!previousCursors.length || audience.isFetching}
          onClick={() => {
            const previous = previousCursors.at(-1);
            setPreviousCursors((cursors) => cursors.slice(0, -1));
            setCursor(previous);
            setSelectedIds([]);
          }}
          className={`rounded-xl border border-black/[0.08] px-4 py-2 text-xs font-semibold disabled:opacity-45 ${focusRing}`}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!audience.data?.nextCursor || audience.isFetching}
          onClick={() => {
            if (!audience.data?.nextCursor) return;
            setPreviousCursors((cursors) => [...cursors, cursor]);
            setCursor(audience.data.nextCursor);
            setSelectedIds([]);
          }}
          className={`rounded-xl border border-black/[0.08] px-4 py-2 text-xs font-semibold disabled:opacity-45 ${focusRing}`}
        >
          Next
        </button>
      </nav>
      <PublicationListsPanel
        publicationId={publication.id}
        lists={lists}
        locked={locked}
        onRefresh={refresh}
      />
    </div>
  );
}

function PublicationListsPanel({
  publicationId,
  lists,
  locked,
  onRefresh,
}: {
  publicationId: string;
  lists: PublicationList[];
  locked: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const createList = useMutation({
    mutationFn: () => createAudienceList({ data: { publicationId, name, description: "" } }),
    onSuccess: async () => {
      setName("");
      await onRefresh();
      toast.success("Subscriber list created");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "List could not be created"),
  });
  const removeList = useMutation({
    mutationFn: (id: string) => deleteAudienceList({ data: { publicationId, id } }),
    onSuccess: onRefresh,
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "List could not be deleted"),
  });
  return (
    <section className="rounded-[28px] border border-black/[0.06] bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-ui-display text-xl">Subscriber lists</h2>
          <p className="mt-1 text-sm text-[#17213a]/48">Lists belong only to this publication.</p>
        </div>
        {!locked && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              createList.mutate();
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New list name"
              aria-label="New subscriber list name"
              required
              maxLength={80}
              className={`min-w-0 rounded-xl border border-black/[0.08] bg-[#f8faff] px-3 py-2 text-sm ${focusRing}`}
            />
            <button
              type="submit"
              disabled={createList.isPending}
              className={`rounded-xl bg-[#17213a] px-3 py-2 text-xs font-semibold text-white disabled:opacity-45 ${focusRing}`}
            >
              Add list
            </button>
          </form>
        )}
      </div>
      {lists.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {lists.map((list) => (
            <span
              key={list.id}
              className="inline-flex items-center gap-1 rounded-full bg-[#f1f4fa] px-3 py-1 text-xs"
            >
              {list.name}
              {!locked && (
                <button
                  type="button"
                  aria-label={`Delete ${list.name}`}
                  onClick={() => removeList.mutate(list.id)}
                  className={`rounded p-0.5 text-red-500 ${focusRing}`}
                >
                  <Trash2 className="size-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function AudienceListPicker({
  publicationId,
  contactId,
  lists,
  listMembers,
  locked,
  onRefresh,
}: {
  publicationId: string;
  contactId: string;
  lists: PublicationList[];
  listMembers: Array<{ list_id: string; contact_id: string }>;
  locked: boolean;
  onRefresh: () => Promise<void>;
}) {
  const membership = new Set(
    listMembers.filter((member) => member.contact_id === contactId).map((member) => member.list_id),
  );
  const update = useMutation({
    mutationFn: (input: { listId: string; included: boolean }) =>
      setAudienceListMember({ data: { publicationId, ...input, contactId } }),
    onSuccess: onRefresh,
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "List membership could not be updated"),
  });
  if (!lists.length) return <span className="text-sm text-[#17213a]/35">No lists</span>;
  return (
    <div className="flex flex-wrap gap-1" aria-label="Subscriber lists">
      {lists.map((list) => {
        const included = membership.has(list.id);
        return (
          <button
            key={list.id}
            type="button"
            disabled={locked || update.isPending}
            onClick={() => update.mutate({ listId: list.id, included: !included })}
            className={`rounded-full border px-2 py-1 text-[11px] font-medium disabled:opacity-55 ${focusRing} ${
              included
                ? "border-[#3478f6]/20 bg-[#dceaff] text-[#245fd0]"
                : "border-black/[0.07] text-[#17213a]/45"
            }`}
          >
            {included ? "✓ " : "+ "}
            {list.name}
          </button>
        );
      })}
    </div>
  );
}

function statusClass(status: PublicationSubscriber["subscription_status"]) {
  if (status === "subscribed") return "bg-emerald-50 text-emerald-700";
  if (status === "unsubscribed") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-700";
}

function sourceLabel(source: string) {
  return source.replaceAll("_", " ");
}
