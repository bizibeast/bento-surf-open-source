import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Bell,
  BellOff,
  Check,
  Copy,
  ExternalLink,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Link2,
  MailPlus,
  MessageCircle,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCheck,
  UserMinus,
  UsersRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { AppHeader } from "@/components/AppHeader";
import { MicroAppPanel, MicroAppTabMotion } from "@/components/MicroAppPanel";
import { MicroAppTabs } from "@/components/MicroAppTabs";
import { UpgradeDialog } from "@/components/UpgradeDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  createCreatorCommunityPost,
  createCreatorCommunityComment,
  deleteCommunityPost,
  deleteCreatorCommunity,
  getCommunityWorkspace,
  inviteCommunityMember,
  moderateCommunityContent,
  saveCommunitySettings,
  setCommunityMemberStatus,
  setCommunityPostPinned,
  updateCommunityMember,
} from "@/lib/community.functions";
import { micro } from "@/lib/micro-app-ui";
import { publicProductPath, publicProductUrl } from "@/lib/application-urls";

const searchSchema = z.object({
  tab: z.enum(["overview", "content", "members", "settings"]).catch("overview"),
  community: z.string().uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_authenticated/community")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Community | bento.surf" }] }),
  loaderDeps: ({ search }) => ({ productId: search.community }),
  loader: ({ context, deps }) => {
    context.queryClient.prefetchQuery({
      queryKey: ["community-workspace", deps.productId],
      queryFn: () =>
        getCommunityWorkspace({
          data: deps.productId ? { productId: deps.productId } : {},
        }),
    });
  },
  component: CommunityWorkspace,
});

type CommunityProduct = {
  id: string;
  title: string;
  slug: string;
  public_slug: string;
  kind: "paid_community" | "membership";
  status: string;
  sales_count: number;
  settings?: {
    welcomeMessage?: string;
    rules?: string;
    allowMemberPosts?: boolean;
  };
};

type CommunityMember = {
  id: string;
  buyer_email: string;
  member_name: string | null;
  source: "purchase" | "manual";
  status: "active" | "revoked" | "expired";
  created_at: string;
  last_accessed_at: string | null;
  community_role: "member" | "moderator";
  community_notifications_enabled: boolean;
};

type CommunityPost = {
  id: string;
  author_kind: "creator" | "member";
  author_name: string;
  body: string;
  is_pinned: boolean;
  resources?: Array<{ label: string; url: string }>;
  moderation_status: "published" | "hidden" | "removed";
  moderation_reason?: string | null;
  created_at: string;
};

type CommunityComment = {
  id: string;
  post_id: string;
  author_kind: "creator" | "member";
  author_name: string;
  body: string;
  moderation_status: "published" | "hidden" | "removed";
  moderation_reason?: string | null;
  created_at: string;
};

type CommunityWorkspaceData = {
  locked: boolean;
  creatorUsername: string;
  products: CommunityProduct[];
  selected: CommunityProduct | null;
  members: CommunityMember[];
  posts: CommunityPost[];
  comments: CommunityComment[];
  stats: {
    activeMembers: number;
    paidMembers: number;
    invitedMembers: number;
    posts: number;
    comments: number;
  };
};

const tabs = [
  { id: "overview", label: "Overview", icon: Sparkles },
  { id: "content", label: "Content", icon: MessageCircle },
  { id: "members", label: "Members & access", icon: UsersRound },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

function CommunityWorkspace() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["community-workspace", search.community],
    queryFn: () =>
      getCommunityWorkspace({
        data: search.community ? { productId: search.community } : {},
      }),
  });
  const data = query.data as CommunityWorkspaceData | undefined;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["community-workspace"] });
  };

  if (query.isPending || !data) {
    return (
      <div className={`flex items-center justify-center ${micro.shell}`}>
        <LoaderCircle className="size-8 animate-spin text-[#3478f6]" />
      </div>
    );
  }

  const selectProduct = (productId: string) =>
    void navigate({
      to: "/community",
      search: { tab: search.tab, community: productId },
    });
  const selectTab = (tab: (typeof tabs)[number]["id"]) =>
    void navigate({
      to: "/community",
      search: { tab, community: data.selected?.id },
    });

  return (
    <main className={`relative overflow-x-clip ${micro.shell}`}>
      <AppHeader
        title="Community"
        actions={
          <Link
            to="/store"
            search={{ tab: "products", create: "paid_community", edit: undefined }}
            className={micro.btnPrimaryCompact}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">New community</span>
          </Link>
        }
      />

      <div className={micro.main}>
        {!data.selected ? (
          <EmptyCommunity locked={data.locked} />
        ) : (
          <>
            <CommunityTopbar
              products={data.products}
              selected={data.selected}
              creatorUsername={data.creatorUsername}
              onSelect={selectProduct}
            />
            <MicroAppTabs
              tabs={tabs}
              value={search.tab}
              onChange={selectTab}
              ariaLabel="Community section"
              className="mt-5"
            />

            {data.locked && (
              <section
                className={`mt-5 flex flex-col gap-4 sm:flex-row sm:items-center ${micro.bannerWarn}`}
              >
                <span className={`${micro.iconWellAmber} size-11 shrink-0`}>
                  <LockKeyhole className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">Your community data is safe</div>
                  <p className={`mt-1 ${micro.mutedXs}`}>
                    Existing members and posts remain visible. Store is required to invite members,
                    publish updates, or change access.
                  </p>
                </div>
                <UpgradeDialog feature="communities" />
              </section>
            )}

            <MicroAppTabMotion tabKey={search.tab}>
              {search.tab === "overview" ? (
                <Overview data={data} onOpenTab={selectTab} />
              ) : search.tab === "content" ? (
                <Content
                  product={data.selected}
                  posts={data.posts}
                  comments={data.comments}
                  locked={data.locked}
                  refresh={refresh}
                />
              ) : search.tab === "members" ? (
                <Members
                  product={data.selected}
                  members={data.members}
                  locked={data.locked}
                  refresh={refresh}
                />
              ) : (
                <CommunitySettings
                  product={data.selected}
                  locked={data.locked}
                  refresh={refresh}
                  onDeleted={() =>
                    void navigate({
                      to: "/community",
                      search: { tab: "overview", community: undefined },
                    })
                  }
                />
              )}
            </MicroAppTabMotion>
          </>
        )}
      </div>
    </main>
  );
}

function EmptyCommunity({ locked }: { locked: boolean }) {
  return (
    <MicroAppPanel className="mx-auto mt-12 max-w-3xl text-center">
      <span className={`${micro.iconWellMint} mx-auto size-14`}>
        <UsersRound className="size-6" />
      </span>
      <p className={`${micro.eyebrow} mt-5`}>Community</p>
      <h2 className="mt-2 font-ui-display text-4xl">Build a home for your people</h2>
      <p className={`mx-auto mt-3 max-w-lg ${micro.muted}`}>
        Create a paid community, welcome members after checkout, invite people manually, and publish
        private updates from one place.
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        {locked ? (
          <UpgradeDialog feature="communities" />
        ) : (
          <Link
            to="/store"
            search={{ tab: "products", create: "paid_community", edit: undefined }}
            className={micro.btnPrimary}
          >
            <Plus className="size-4" /> Create community
          </Link>
        )}
      </div>
    </MicroAppPanel>
  );
}

function CommunityTopbar({
  products,
  selected,
  creatorUsername,
  onSelect,
}: {
  products: CommunityProduct[];
  selected: CommunityProduct;
  creatorUsername: string;
  onSelect: (id: string) => void;
}) {
  const copyLink = async () => {
    const url = publicProductUrl(
      creatorUsername,
      selected.public_slug,
      import.meta.env.VITE_PUBLIC_URL,
    );
    await navigator.clipboard.writeText(url);
    toast.success("Community link copied");
  };
  return (
    <section
      className={`${micro.panel} ${micro.panelPad} flex flex-col gap-4 sm:flex-row sm:items-center`}
    >
      <span className={`${micro.iconWellMint} size-12 shrink-0 rounded-[19px]`}>
        <UsersRound className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        {products.length > 1 ? (
          <select
            value={selected.id}
            onChange={(event) => onSelect(event.target.value)}
            className="max-w-full appearance-none bg-transparent pr-8 font-ui-display text-2xl outline-none"
            aria-label="Select community"
          >
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.title}
              </option>
            ))}
          </select>
        ) : (
          <h2 className="truncate font-ui-display text-2xl">{selected.title}</h2>
        )}
        <div className={`mt-1 flex items-center gap-2 ${micro.mutedXs}`}>
          <span
            className={`size-1.5 rounded-full ${selected.status === "published" ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          {selected.status === "published" ? "Live" : "Draft"} ·{" "}
          {selected.kind === "membership" ? "Membership" : "Paid community"}
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => void copyLink()} className={micro.btnOutline}>
          <Copy className="size-4" /> Copy link
        </button>
        <a
          href={publicProductPath(creatorUsername, selected.public_slug)}
          target="_blank"
          rel="noreferrer"
          className={`${micro.btnOutline} size-10 !px-0`}
          aria-label="Open community sales page"
        >
          <ExternalLink className="size-4" />
        </a>
      </div>
    </section>
  );
}

function Overview({
  data,
  onOpenTab,
}: {
  data: CommunityWorkspaceData;
  onOpenTab: (tab: "content" | "members" | "settings") => void;
}) {
  const recentMembers = data.members.slice(0, 4);
  const recentPosts = data.posts.slice(0, 3);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={UsersRound} label="Active members" value={data.stats.activeMembers} />
        <Metric icon={ShieldCheck} label="Joined by purchase" value={data.stats.paidMembers} />
        <Metric icon={MailPlus} label="Invited by you" value={data.stats.invitedMembers} />
        <Metric
          icon={MessageCircle}
          label="Posts & comments"
          value={data.stats.posts + data.stats.comments}
        />
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
        <MicroAppPanel>
          <SectionTitle
            title="Latest posts"
            copy="What members are seeing in their private feed."
            action="Manage content"
            onAction={() => onOpenTab("content")}
          />
          <div className="mt-5 space-y-3">
            {recentPosts.length ? (
              recentPosts.map((post) => <PostPreview key={post.id} post={post} />)
            ) : (
              <EmptyRow icon={MessageCircle} text="Publish the first welcome update." />
            )}
          </div>
        </MicroAppPanel>
        <MicroAppPanel>
          <SectionTitle
            title="Recent members"
            copy="Purchases and manual invitations appear together."
            action="Manage access"
            onAction={() => onOpenTab("members")}
          />
          <div className="mt-5 space-y-2">
            {recentMembers.length ? (
              recentMembers.map((member) => (
                <div key={member.id} className={`flex items-center gap-3 px-3 py-3 ${micro.soft}`}>
                  <Avatar name={member.member_name || member.buyer_email} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {member.member_name || member.buyer_email.split("@")[0]}
                    </div>
                    <div className={`truncate ${micro.mutedXs}`}>{member.buyer_email}</div>
                  </div>
                  <StatusPill status={member.status} />
                </div>
              ))
            ) : (
              <EmptyRow icon={UsersRound} text="Your first members will appear here." />
            )}
          </div>
        </MicroAppPanel>
      </div>
    </div>
  );
}

function Content({
  product,
  posts,
  comments,
  locked,
  refresh,
}: {
  product: CommunityProduct;
  posts: CommunityPost[];
  comments: CommunityComment[];
  locked: boolean;
  refresh: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [resourceLabel, setResourceLabel] = useState("");
  const [resourceUrl, setResourceUrl] = useState("");
  const [commentBodies, setCommentBodies] = useState<Record<string, string>>({});
  const publish = useMutation({
    mutationFn: () =>
      createCreatorCommunityPost({
        data: {
          productId: product.id,
          body,
          pinned,
          resources:
            resourceLabel.trim() && resourceUrl.trim()
              ? [{ label: resourceLabel, url: resourceUrl }]
              : [],
        },
      }),
    onSuccess: async () => {
      setBody("");
      setPinned(false);
      setResourceLabel("");
      setResourceUrl("");
      await refresh();
      toast.success("Update published");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not publish update"),
  });
  const pin = useMutation({
    mutationFn: (post: CommunityPost) =>
      setCommunityPostPinned({
        data: { productId: product.id, postId: post.id, pinned: !post.is_pinned },
      }),
    onSuccess: refresh,
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not pin post"),
  });
  const remove = useMutation({
    mutationFn: (postId: string) =>
      deleteCommunityPost({ data: { productId: product.id, postId } }),
    onSuccess: async () => {
      await refresh();
      toast.success("Post deleted");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not delete post"),
  });
  const comment = useMutation({
    mutationFn: (postId: string) =>
      createCreatorCommunityComment({
        data: { productId: product.id, postId, body: commentBodies[postId] || "" },
      }),
    onSuccess: async (result) => {
      setCommentBodies((current) => ({ ...current, [result.post_id]: "" }));
      await refresh();
      toast.success("Reply published");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not reply"),
  });
  const moderate = useMutation({
    mutationFn: (input: {
      kind: "post" | "comment";
      contentId: string;
      status: "published" | "hidden";
    }) =>
      moderateCommunityContent({
        data: {
          productId: product.id,
          kind: input.kind,
          contentId: input.contentId,
          status: input.status,
        },
      }),
    onSuccess: async () => {
      await refresh();
      toast.success("Moderation updated");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update moderation"),
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <MicroAppPanel className="h-fit lg:sticky lg:top-28">
        <div className="flex items-center gap-3">
          <span className={`${micro.iconWellMint} size-10`}>
            <Send className="size-4" />
          </span>
          <div>
            <h2 className="font-ui-display text-2xl">New update</h2>
            <p className={micro.mutedXs}>Published to every active member.</p>
          </div>
        </div>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={locked}
          placeholder="Share an update, resource, prompt, or announcement…"
          className={`${inputClass} mt-5 min-h-44 resize-y`}
          maxLength={10_000}
        />
        <label className={`mt-3 flex items-center gap-3 px-3 py-3 text-sm ${micro.soft}`}>
          <input
            type="checkbox"
            checked={pinned}
            onChange={(event) => setPinned(event.target.checked)}
            disabled={locked}
            className="size-4 accent-current"
          />
          Pin this update to the top
        </label>
        <div className={`mt-3 p-3 ${micro.soft}`}>
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Link2 className="size-3.5" /> Optional resource
          </div>
          <div className="mt-2 grid gap-2">
            <input
              value={resourceLabel}
              onChange={(event) => setResourceLabel(event.target.value)}
              placeholder="Resource label"
              maxLength={80}
              disabled={locked}
              className={inputClass}
            />
            <input
              type="url"
              value={resourceUrl}
              onChange={(event) => setResourceUrl(event.target.value)}
              placeholder="https://…"
              maxLength={2_000}
              disabled={locked}
              className={inputClass}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => publish.mutate()}
          disabled={locked || !body.trim() || publish.isPending}
          className={`${micro.btnPrimary} mt-4 w-full`}
        >
          {publish.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          Publish update
        </button>
      </MicroAppPanel>
      <MicroAppPanel>
        <SectionTitle title="Member feed" copy={`${posts.length} published posts`} />
        <div className="mt-5 space-y-3">
          {posts.length ? (
            posts.map((post) => (
              <article
                key={post.id}
                className={`rounded-[22px] border border-black/[0.06] p-4 ${micro.soft}`}
              >
                <div className="flex items-start gap-3">
                  <Avatar name={post.author_name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{post.author_name}</span>
                      <span className={`${micro.eyebrowMuted} rounded-full bg-white px-2 py-1`}>
                        {post.author_kind}
                      </span>
                      {post.is_pinned && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                          <Pin className="size-3" /> Pinned
                        </span>
                      )}
                      {post.moderation_status !== "published" && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700">
                          <EyeOff className="size-3" /> Hidden
                        </span>
                      )}
                    </div>
                    <div className={`mt-1 ${micro.mutedXs}`}>{formatDate(post.created_at)}</div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => pin.mutate(post)}
                      disabled={locked || pin.isPending}
                      className="inline-flex size-9 items-center justify-center rounded-xl transition hover:bg-[#e8eef9] disabled:opacity-35"
                      aria-label={post.is_pinned ? "Unpin post" : "Pin post"}
                    >
                      <Pin className="size-4" />
                    </button>
                    {post.author_kind === "member" && (
                      <button
                        type="button"
                        onClick={() =>
                          moderate.mutate({
                            kind: "post",
                            contentId: post.id,
                            status: post.moderation_status === "published" ? "hidden" : "published",
                          })
                        }
                        disabled={locked || moderate.isPending}
                        className="inline-flex size-9 items-center justify-center rounded-xl transition hover:bg-[#e8eef9] disabled:opacity-35"
                        aria-label={
                          post.moderation_status === "published" ? "Hide post" : "Restore post"
                        }
                      >
                        <EyeOff className="size-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm("Delete this community post?")) remove.mutate(post.id);
                      }}
                      disabled={locked || remove.isPending}
                      className="inline-flex size-9 items-center justify-center rounded-xl text-destructive transition hover:bg-destructive/10 disabled:opacity-35"
                      aria-label="Delete post"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
                <p className={`mt-4 whitespace-pre-wrap ${micro.muted}`}>{post.body}</p>
                {!!post.resources?.length && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {post.resources.map((resource) => (
                      <a
                        key={`${post.id}:${resource.url}`}
                        href={resource.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold shadow-sm"
                      >
                        <Link2 className="size-3.5 shrink-0" />
                        <span className="truncate">{resource.label}</span>
                      </a>
                    ))}
                  </div>
                )}
                <div className="mt-4 space-y-2 border-t border-black/[0.06] pt-3">
                  {comments
                    .filter((item) => item.post_id === post.id)
                    .map((item) => (
                      <div key={item.id} className="flex gap-3 rounded-2xl bg-white px-3 py-3">
                        <Avatar name={item.author_name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-semibold">{item.author_name}</span>
                            <span className="text-[#17213a]/55">{formatDate(item.created_at)}</span>
                            {item.moderation_status !== "published" && (
                              <span className="font-semibold text-amber-700">Hidden</span>
                            )}
                          </div>
                          <p className={`mt-1 whitespace-pre-wrap ${micro.mutedXs}`}>{item.body}</p>
                        </div>
                        {item.author_kind === "member" && (
                          <button
                            type="button"
                            onClick={() =>
                              moderate.mutate({
                                kind: "comment",
                                contentId: item.id,
                                status:
                                  item.moderation_status === "published" ? "hidden" : "published",
                              })
                            }
                            disabled={locked || moderate.isPending}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl hover:bg-[#e8eef9] disabled:opacity-35"
                            aria-label={
                              item.moderation_status === "published"
                                ? "Hide comment"
                                : "Restore comment"
                            }
                          >
                            <EyeOff className="size-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      comment.mutate(post.id);
                    }}
                    className="flex min-w-0 gap-2"
                  >
                    <input
                      value={commentBodies[post.id] || ""}
                      onChange={(event) =>
                        setCommentBodies((current) => ({
                          ...current,
                          [post.id]: event.target.value,
                        }))
                      }
                      placeholder="Reply as the creator…"
                      maxLength={3_000}
                      disabled={locked}
                      className={`${inputClass} min-w-0 flex-1`}
                    />
                    <button
                      type="submit"
                      disabled={locked || !commentBodies[post.id]?.trim() || comment.isPending}
                      className={`${micro.btnPrimary} size-11 shrink-0 !px-0`}
                      aria-label="Publish reply"
                    >
                      <Send className="size-4" />
                    </button>
                  </form>
                </div>
              </article>
            ))
          ) : (
            <EmptyRow icon={MessageCircle} text="No posts yet. Publish the first update." />
          )}
        </div>
      </MicroAppPanel>
    </div>
  );
}

function Members({
  product,
  members,
  locked,
  refresh,
}: {
  product: CommunityProduct;
  members: CommunityMember[];
  locked: boolean;
  refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "moderator">("member");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) =>
      `${member.member_name || ""} ${member.buyer_email}`.toLowerCase().includes(query),
    );
  }, [members, search]);
  const invite = useMutation({
    mutationFn: () =>
      inviteCommunityMember({
        data: {
          productId: product.id,
          email,
          name: name || undefined,
          role,
          notificationsEnabled,
        },
      }),
    onSuccess: async (result) => {
      setName("");
      setEmail("");
      setRole("member");
      setNotificationsEnabled(true);
      await refresh();
      toast.success(
        result.emailQueued
          ? "Invitation sent"
          : "Access created, but the invitation email could not be sent. Revoke and restore access to resend it.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not invite member"),
  });
  const status = useMutation({
    mutationFn: (member: CommunityMember) =>
      setCommunityMemberStatus({
        data: {
          grantId: member.id,
          status: member.status === "active" ? "revoked" : "active",
        },
      }),
    onSuccess: async (result) => {
      await refresh();
      toast.success(
        result.status === "revoked"
          ? "Access revoked"
          : result.emailQueued
            ? "Access restored and link sent"
            : "Access restored, but the email could not be sent. Revoke and restore access to resend it.",
      );
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update access"),
  });
  const update = useMutation({
    mutationFn: (input: {
      member: CommunityMember;
      role: "member" | "moderator";
      notificationsEnabled: boolean;
    }) =>
      updateCommunityMember({
        data: {
          grantId: input.member.id,
          role: input.role,
          notificationsEnabled: input.notificationsEnabled,
        },
      }),
    onSuccess: async () => {
      await refresh();
      toast.success("Member settings saved");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not update member settings"),
  });

  return (
    <div className="space-y-5">
      <MicroAppPanel>
        <div className="flex items-center gap-3">
          <span className={`${micro.iconWell} size-11 rounded-[18px]`}>
            <MailPlus className="size-5" />
          </span>
          <div>
            <h2 className="font-ui-display text-2xl">Give someone access</h2>
            <p className={micro.mutedXs}>
              They receive a branded email with a private member link.
            </p>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
          className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-[.8fr_1fr_.65fr_auto_auto]"
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (optional)"
            maxLength={120}
            disabled={locked}
            className={inputClass}
          />
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="member@example.com"
            maxLength={254}
            disabled={locked}
            className={inputClass}
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as "member" | "moderator")}
            disabled={locked}
            className={inputClass}
            aria-label="Community role"
          >
            <option value="member">Member</option>
            <option value="moderator">Moderator</option>
          </select>
          <label className={`flex items-center gap-2 px-3 py-3 text-xs ${micro.soft}`}>
            <input
              type="checkbox"
              checked={notificationsEnabled}
              onChange={(event) => setNotificationsEnabled(event.target.checked)}
              disabled={locked}
              className="size-4 accent-current"
            />
            Email updates
          </label>
          <button type="submit" disabled={locked || invite.isPending} className={micro.btnPrimary}>
            {invite.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Send invite
          </button>
        </form>
      </MicroAppPanel>
      <MicroAppPanel>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <h2 className="font-ui-display text-2xl">Members</h2>
            <p className={micro.mutedXs}>
              {members.length} total · access history is never deleted
            </p>
          </div>
          <label className="relative block sm:w-72">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#17213a]/45" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search members"
              className={`${inputClass} pl-10`}
            />
          </label>
        </div>
        <div className="mt-5 overflow-hidden rounded-[22px] border border-black/[0.06]">
          {filtered.length ? (
            filtered.map((member, index) => (
              <div
                key={member.id}
                className={`grid gap-3 bg-white px-4 py-4 lg:grid-cols-[1.2fr_.55fr_.7fr_.85fr_auto] lg:items-center ${
                  index ? "border-t border-black/[0.06]" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={member.member_name || member.buyer_email} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {member.member_name || member.buyer_email.split("@")[0]}
                    </div>
                    <div className={`truncate ${micro.mutedXs}`}>{member.buyer_email}</div>
                  </div>
                </div>
                <div>
                  <span className={`${micro.eyebrowMuted} rounded-full bg-[#f2f5fb] px-2.5 py-1.5`}>
                    {member.source === "purchase" ? "Purchased" : "Invited"}
                  </span>
                </div>
                <div className={micro.mutedXs}>
                  <div>{member.last_accessed_at ? "Last active" : "Joined"}</div>
                  <div className="mt-0.5 font-medium text-[#17213a]/70">
                    {formatDate(member.last_accessed_at || member.created_at)}
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <select
                    value={member.community_role}
                    onChange={(event) =>
                      update.mutate({
                        member,
                        role: event.target.value as "member" | "moderator",
                        notificationsEnabled: member.community_notifications_enabled,
                      })
                    }
                    disabled={locked || update.isPending || member.status !== "active"}
                    className="min-w-0 flex-1 rounded-xl border border-black/[0.08] bg-[#f8faff] px-2.5 py-2 text-xs outline-none disabled:opacity-45"
                    aria-label={`Role for ${member.member_name || member.buyer_email}`}
                  >
                    <option value="member">Member</option>
                    <option value="moderator">Moderator</option>
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      update.mutate({
                        member,
                        role: member.community_role,
                        notificationsEnabled: !member.community_notifications_enabled,
                      })
                    }
                    disabled={locked || update.isPending || member.status !== "active"}
                    className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-35 ${
                      member.community_notifications_enabled
                        ? "bg-emerald-500/10 text-emerald-700"
                        : "bg-[#f2f5fb] text-[#17213a]/45"
                    }`}
                    aria-label={
                      member.community_notifications_enabled
                        ? "Turn email updates off"
                        : "Turn email updates on"
                    }
                    title={
                      member.community_notifications_enabled
                        ? "Email updates on"
                        : "Email updates off"
                    }
                  >
                    {member.community_notifications_enabled ? (
                      <Bell className="size-4" />
                    ) : (
                      <BellOff className="size-4" />
                    )}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <StatusPill status={member.status} />
                  <button
                    type="button"
                    onClick={() => status.mutate(member)}
                    disabled={locked || status.isPending}
                    className={`inline-flex size-9 items-center justify-center rounded-xl transition disabled:opacity-35 ${
                      member.status === "active"
                        ? "text-destructive hover:bg-destructive/10"
                        : "text-emerald-700 hover:bg-emerald-500/10"
                    }`}
                    aria-label={member.status === "active" ? "Revoke access" : "Restore access"}
                    title={member.status === "active" ? "Revoke access" : "Restore and email link"}
                  >
                    {member.status === "active" ? (
                      <UserMinus className="size-4" />
                    ) : (
                      <UserCheck className="size-4" />
                    )}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="p-5">
              <EmptyRow
                icon={UsersRound}
                text={search ? "No members match this search." : "No members yet."}
              />
            </div>
          )}
        </div>
      </MicroAppPanel>
    </div>
  );
}

function CommunitySettings({
  product,
  locked,
  refresh,
  onDeleted,
}: {
  product: CommunityProduct;
  locked: boolean;
  refresh: () => Promise<void>;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState(product.settings?.welcomeMessage || "");
  const [rules, setRules] = useState(product.settings?.rules || "");
  const [allowMemberPosts, setAllowMemberPosts] = useState(
    product.settings?.allowMemberPosts !== false,
  );
  useEffect(() => {
    setWelcomeMessage(product.settings?.welcomeMessage || "");
    setRules(product.settings?.rules || "");
    setAllowMemberPosts(product.settings?.allowMemberPosts !== false);
  }, [product]);
  const save = useMutation({
    mutationFn: () =>
      saveCommunitySettings({
        data: { productId: product.id, welcomeMessage, rules, allowMemberPosts },
      }),
    onSuccess: async () => {
      await refresh();
      toast.success("Community settings saved");
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not save settings"),
  });
  const remove = useMutation({
    mutationFn: () => deleteCreatorCommunity({ data: { productId: product.id } }),
    onSuccess: async (result) => {
      setConfirmDelete(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["community-workspace"] }),
        queryClient.invalidateQueries({ queryKey: ["my-commerce"] }),
      ]);
      toast.success(
        result.archived
          ? "Community archived; member receipts and access were kept safe"
          : "Community deleted",
      );
      onDeleted();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not delete community"),
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_330px]">
      <MicroAppPanel>
        <div className="flex items-center gap-3">
          <span className={`${micro.iconWellLavender} size-11 rounded-[18px]`}>
            <Settings2 className="size-5" />
          </span>
          <div>
            <h2 className="font-ui-display text-2xl">Member experience</h2>
            <p className={micro.mutedXs}>These settings appear inside the private member space.</p>
          </div>
        </div>
        <label className="mt-6 block">
          <span className="text-sm font-semibold">Welcome message</span>
          <span className={`mt-1 block ${micro.mutedXs}`}>
            Set expectations when members first arrive.
          </span>
          <textarea
            value={welcomeMessage}
            onChange={(event) => setWelcomeMessage(event.target.value)}
            disabled={locked}
            maxLength={2_000}
            className={`${inputClass} mt-3 min-h-28`}
          />
        </label>
        <label className="mt-5 block">
          <span className="text-sm font-semibold">Community guidelines</span>
          <span className={`mt-1 block ${micro.mutedXs}`}>
            Keep this short, warm, and easy to understand.
          </span>
          <textarea
            value={rules}
            onChange={(event) => setRules(event.target.value)}
            disabled={locked}
            maxLength={5_000}
            className={`${inputClass} mt-3 min-h-36`}
            placeholder="Be generous, stay on topic, and respect member privacy."
          />
        </label>
        <label
          className={`mt-5 flex items-center gap-4 border border-black/[0.06] p-4 ${micro.soft}`}
        >
          <span className={`${micro.iconWell} size-10`}>
            <MessageCircle className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Allow member posts</span>
            <span className={`mt-1 block leading-5 ${micro.mutedXs}`}>
              Turn this off for a creator-only announcement feed.
            </span>
          </span>
          <input
            type="checkbox"
            checked={allowMemberPosts}
            onChange={(event) => setAllowMemberPosts(event.target.checked)}
            disabled={locked}
            className="size-5 accent-current"
          />
        </label>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={locked || !welcomeMessage.trim() || save.isPending}
          className={`${micro.btnPrimary} mt-6`}
        >
          {save.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          Save settings
        </button>
      </MicroAppPanel>
      <div className="space-y-5">
        <MicroAppPanel>
          <ShieldCheck className="size-5 text-emerald-600" />
          <h3 className="mt-4 font-ui-display text-2xl">Access rules</h3>
          <ul className={`mt-4 space-y-3 ${micro.muted}`}>
            <li>Paid buyers get access after a confirmed checkout.</li>
            <li>Manual invites receive a private link by email.</li>
            <li>Revoking access does not delete purchase history.</li>
          </ul>
        </MicroAppPanel>
        <MicroAppPanel>
          <h3 className="font-ui-display text-2xl">Product details</h3>
          <p className={`mt-2 ${micro.muted}`}>
            Price, billing cadence, cover, description, and publication status are managed with the
            product.
          </p>
          <Link
            to="/store"
            search={{ tab: "products", create: undefined, edit: product.id }}
            className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#3478f6]"
          >
            Edit product <ArrowUpRight className="size-4" />
          </Link>
        </MicroAppPanel>
        <MicroAppPanel>
          <span className="flex size-11 items-center justify-center rounded-2xl bg-red-50 text-red-600">
            <Trash2 className="size-5" />
          </span>
          <h3 className="mt-4 font-ui-display text-2xl">Delete community</h3>
          <p className={`mt-2 ${micro.muted}`}>
            Remove this community from your workspace. If anyone has already purchased access,
            receipts and member access stay safe and the community is archived instead.
          </p>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={remove.isPending}
            className="mt-5 inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-red-600 ring-1 ring-red-200 transition hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="size-4" /> Delete community
          </button>
        </MicroAppPanel>
      </div>
      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (remove.isPending) return;
          setConfirmDelete(open);
        }}
      >
        <DialogContent className="max-w-md overflow-hidden rounded-[30px] border-0 bg-white p-0 shadow-2xl">
          <div className="bg-gradient-to-br from-red-50 via-white to-[#eef5ff] p-6 sm:p-7">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-red-100 text-red-600">
              <Trash2 className="size-5" />
            </div>
            <DialogTitle className="mt-5 font-ui-display text-3xl leading-tight text-[#17213a]">
              Delete {product.title}?
            </DialogTitle>
            <p className="mt-3 text-sm leading-6 text-[#17213a]/55">
              This removes the community, its posts, and its Bento blocks. Communities with
              purchases cannot be erased, so receipts and member access always stay safe.
            </p>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => setConfirmDelete(false)}
                className="rounded-2xl border border-black/[0.08] bg-white px-4 py-2.5 text-sm font-semibold text-[#17213a] disabled:opacity-50"
              >
                Keep community
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {remove.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Delete permanently
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <MicroAppPanel className="min-h-32">
      <div className={`${micro.iconWell} size-9`}>
        <Icon className="size-4" />
      </div>
      <div className="mt-4 text-3xl font-semibold tracking-tight">{value.toLocaleString()}</div>
      <div className={`mt-1 ${micro.mutedXs}`}>{label}</div>
    </MicroAppPanel>
  );
}

function SectionTitle({
  title,
  copy,
  action,
  onAction,
}: {
  title: string;
  copy: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="font-ui-display text-2xl">{title}</h2>
        <p className={`mt-1 ${micro.mutedXs}`}>{copy}</p>
      </div>
      {action && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#17213a]/55 transition hover:text-[#17213a]"
        >
          {action} <ArrowUpRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function PostPreview({ post }: { post: CommunityPost }) {
  return (
    <article className={`p-4 ${micro.soft}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold">{post.author_name}</span>
        {post.is_pinned && <Pin className="size-3 text-emerald-600" />}
        <span className={`ml-auto ${micro.mutedXs}`}>{formatDate(post.created_at)}</span>
      </div>
      <p className={`mt-2 line-clamp-3 whitespace-pre-wrap ${micro.muted}`}>{post.body}</p>
    </article>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className={`${micro.iconWellMint} size-10 shrink-0 text-sm font-semibold`}>
      {name.trim().slice(0, 1).toUpperCase() || "M"}
    </span>
  );
}

function StatusPill({ status }: { status: CommunityMember["status"] }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[10px] font-semibold capitalize ${
        status === "active"
          ? "bg-emerald-500/12 text-emerald-700"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {status}
    </span>
  );
}

function EmptyRow({ icon: Icon, text }: { icon: typeof MoreHorizontal; text: string }) {
  return (
    <div className={`${micro.empty} flex items-center justify-center gap-3 !p-5 text-sm`}>
      <Icon className="size-4 text-[#3478f6]" />
      <span className="text-[#17213a]/55">{text}</span>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

const inputClass = `${micro.input} disabled:cursor-not-allowed disabled:opacity-55`;
