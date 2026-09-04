import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";
import { AppHeader } from "@/components/AppHeader";
import { EmailAudiencePanel } from "@/components/email-marketing/EmailAudiencePanel";
import { EmailBroadcastsPanel } from "@/components/email-marketing/EmailBroadcastsPanel";
import {
  EmailMarketingOverview,
  type EmailMarketingSection,
} from "@/components/email-marketing/EmailMarketingOverview";
import {
  NewsletterPostsTable,
  type NewsletterPostTableRecord,
} from "@/components/email-marketing/NewsletterPostsTable";
import { NewsletterPostDetail } from "@/components/email-marketing/NewsletterPostDetail";
import {
  NewsletterSettings,
  type NewsletterSettingsPanel,
} from "@/components/email-marketing/NewsletterSettings";
import { NewsletterTemplates } from "@/components/email-marketing/NewsletterTemplates";
import { NewsletterWebsite } from "@/components/email-marketing/NewsletterWebsite";
import { NewsletterWorkspace } from "@/components/email-marketing/NewsletterWorkspace";
import { PublicationPicker } from "@/components/email-marketing/PublicationPicker";
import {
  getMyEmailMarketing,
  getPublicationRecipientCounts,
} from "@/lib/commerce-growth.functions";
import { micro } from "@/lib/micro-app-ui";
import {
  addNewsletterToBento,
  archiveNewsletterPublication,
  deleteNewsletterDraft,
  getMyNewsletterPublication,
  getMyNewsletterPublications,
  removeNewsletterFromBento,
  saveNewsletterIssue,
  savePaidNewsletterOffer,
  setDefaultNewsletterPublication,
  updateNewsletterPublication,
} from "@/lib/newsletter.functions";
import {
  createTemplatePostContent,
  getNewsletterTemplate,
  uniqueTemplatePostIdentity,
  type NewsletterTemplateId,
} from "@/lib/newsletter-templates";
import {
  resolveSelectedPublicationId,
  type NewsletterPublicationSummary,
} from "@/lib/newsletter-publications";

const sections = [
  "overview",
  "write",
  "posts",
  "broadcasts",
  "templates",
  "subscribers",
  "website",
  "settings",
] as const;

const visibleSections = [
  "overview",
  "posts",
  "broadcasts",
  "subscribers",
  "templates",
  "website",
  "settings",
] as const;

const sectionLabels: Record<EmailMarketingSection, string> = {
  overview: "Overview",
  write: "Write",
  posts: "Posts",
  broadcasts: "Broadcasts",
  templates: "Templates",
  subscribers: "Audience",
  website: "Website",
  settings: "Settings",
};

const legacySections = {
  newsletter: "overview",
  broadcasts: "broadcasts",
  audience: "subscribers",
} as const;

const searchSchema = z
  .object({
    publication: z.string().uuid().optional().catch(undefined),
    section: z.enum(sections).optional().catch(undefined),
    post: z.string().uuid().optional().catch(undefined),
    intent: z.enum(["schedule"]).optional().catch(undefined),
    settings: z
      .enum(["details", "seo", "branding", "template", "email", "paid", "advanced"])
      .optional()
      .catch(undefined),
    tab: z.enum(["newsletter", "broadcasts", "audience"]).optional().catch(undefined),
  })
  .transform(({ tab, section, ...search }) => ({
    ...search,
    section: section ?? legacySections[tab ?? "newsletter"],
  }));

export const Route = createFileRoute("/_authenticated/email-marketing")({
  head: () => ({ meta: [{ title: "Email Marketing | bento.surf" }] }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ publication: search.publication }),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.prefetchQuery({
        queryKey: ["newsletter-publications"],
        queryFn: () => getMyNewsletterPublications(),
      }),
      context.queryClient.prefetchQuery({
        queryKey: ["my-email-marketing"],
        queryFn: () => getMyEmailMarketing(),
      }),
      deps.publication
        ? context.queryClient.prefetchQuery({
            queryKey: ["newsletter-publication", deps.publication],
            queryFn: () =>
              getMyNewsletterPublication({ data: { publicationId: deps.publication as string } }),
          })
        : Promise.resolve(),
    ]),
  component: EmailMarketingPage,
});

function queryError(error: unknown) {
  return error instanceof Error ? error.message : null;
}

function EmailMarketingPage() {
  const {
    publication: requestedPublicationId,
    section,
    post: requestedPostId,
    intent: requestedIntent,
    settings: requestedSettings,
  } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const publicationsQuery = useQuery({
    queryKey: ["newsletter-publications"],
    queryFn: () => getMyNewsletterPublications(),
  });
  const marketingQuery = useQuery({
    queryKey: ["my-email-marketing"],
    queryFn: () => getMyEmailMarketing(),
  });
  const publications: NewsletterPublicationSummary[] = publicationsQuery.data ?? [];
  const selectedPublicationId = resolveSelectedPublicationId(publications, requestedPublicationId);
  const selectedSummary = publications.find(
    (publication) => publication.id === selectedPublicationId,
  );
  const publicationQuery = useQuery({
    queryKey: ["newsletter-publication", selectedPublicationId],
    queryFn: () =>
      getMyNewsletterPublication({ data: { publicationId: selectedPublicationId as string } }),
    enabled: Boolean(selectedPublicationId),
  });
  const marketing = marketingQuery.data;
  const recipientCountsQuery = useQuery({
    queryKey: ["newsletter-recipient-counts", selectedPublicationId],
    queryFn: () =>
      getPublicationRecipientCounts({ data: { publicationId: selectedPublicationId as string } }),
    enabled: Boolean(selectedPublicationId && marketing && !marketing.locked),
  });
  const selectedData = publicationQuery.data;

  useEffect(() => {
    if (!selectedPublicationId || requestedPublicationId === selectedPublicationId) return;
    void navigate({
      to: "/email-marketing",
      search: {
        publication: selectedPublicationId,
        section,
        ...(requestedPostId ? { post: requestedPostId } : {}),
        ...(requestedIntent ? { intent: requestedIntent } : {}),
        ...(requestedSettings ? { settings: requestedSettings } : {}),
      },
      replace: true,
    });
  }, [
    navigate,
    requestedIntent,
    requestedPostId,
    requestedPublicationId,
    requestedSettings,
    section,
    selectedPublicationId,
  ]);

  const navigateSection = (
    nextSection: EmailMarketingSection,
    nextPostId?: string | null,
    intent?: "schedule",
  ) => {
    window.scrollTo({ left: 0, top: 0, behavior: "auto" });
    const postId = nextPostId === null ? undefined : (nextPostId ?? requestedPostId);
    void navigate({
      to: "/email-marketing",
      search: {
        publication: selectedPublicationId ?? undefined,
        section: nextSection,
        ...(postId ? { post: postId } : {}),
        ...(intent ? { intent } : {}),
      },
    });
  };

  const selectPublication = (publicationId: string) => {
    void navigate({
      to: "/email-marketing",
      search: {
        publication: publicationId,
        section,
        ...(section === "settings" && requestedSettings ? { settings: requestedSettings } : {}),
      },
    });
  };

  const navigateSettings = (settings: NewsletterSettingsPanel) => {
    void navigate({
      to: "/email-marketing",
      search: {
        publication: selectedPublicationId ?? undefined,
        section: "settings",
        settings,
      },
    });
  };

  const publicationCreated = async (publicationId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["newsletter-publications"] });
    await navigate({
      to: "/email-marketing",
      search: { publication: publicationId, section: "overview" },
    });
  };

  const refreshMarketing = async () => {
    await queryClient.invalidateQueries({ queryKey: ["my-email-marketing"] });
  };

  const refreshPublication = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["newsletter-publication", selectedPublicationId],
    });
    await queryClient.invalidateQueries({ queryKey: ["newsletter-publications"] });
  };

  const setDefaultTemplate = async (templateId: NewsletterTemplateId) => {
    const publication = selectedData?.publication;
    if (!publication) return;
    await updateNewsletterPublication({
      data: {
        publicationId: publication.id,
        title: publication.title,
        description: publication.description ?? "",
        senderName: publication.sender_name,
        replyToEmail: publication.reply_to_email || null,
        postalAddress: publication.postal_address,
        accentColor: publication.accent_color || null,
        logoUrl: publication.logo_url || null,
        defaultTemplateId: templateId,
        status: publication.status === "published" ? "published" : "draft",
      },
    });
    await refreshPublication();
  };

  const saveTemplateDraft = async (templateId: NewsletterTemplateId) => {
    const publication = selectedData?.publication;
    if (!publication) return;
    const template = getNewsletterTemplate(templateId);
    const identity = uniqueTemplatePostIdentity(template.name, selectedData.posts ?? []);
    const saved = await saveNewsletterIssue({
      data: {
        publicationId: publication.id,
        templateId,
        listId: null,
        name: identity.name,
        subject: template.subject,
        previewText: template.previewText,
        publicSlug: identity.publicSlug,
        webVisibility: "public",
        content: createTemplatePostContent(templateId),
        status: "draft",
      },
    });
    await refreshPublication();
    navigateSection("write", saved.id);
  };

  const duplicatePost = async (post: NewsletterPostTableRecord) => {
    const publication = selectedData?.publication;
    if (!publication) return;
    const identity = uniqueTemplatePostIdentity(post.name, selectedData?.posts ?? []);
    const saved = await saveNewsletterIssue({
      data: {
        publicationId: publication.id,
        templateId: post.template_id ?? null,
        listId: post.list_id ?? null,
        name: identity.name,
        subject: post.subject,
        previewText: post.preview_text ?? "",
        publicSlug: identity.publicSlug,
        webVisibility: post.web_visibility,
        content: post.content.map((block) => ({ ...block, id: crypto.randomUUID() })),
        status: "draft",
      },
    });
    await refreshPublication();
    navigateSection("write", saved.id);
  };

  const deleteDraft = async (post: NewsletterPostTableRecord) => {
    const publication = selectedData?.publication;
    if (!publication) return;
    if (!window.confirm(`Delete draft “${post.name}”?`)) return;
    await deleteNewsletterDraft({
      data: { id: post.id, publicationId: publication.id },
    });
    await refreshPublication();
  };

  const setPublicationOnBento = async (enabled: boolean) => {
    if (!selectedData?.publication) return;
    if (enabled) {
      await addNewsletterToBento({ data: { publicationId: selectedData.publication.id } });
    } else {
      await removeNewsletterFromBento({ data: { publicationId: selectedData.publication.id } });
    }
    await refreshPublication();
  };

  const selectedError =
    queryError(publicationsQuery.error) ||
    queryError(publicationQuery.error) ||
    queryError(marketingQuery.error) ||
    queryError(recipientCountsQuery.error);
  const locked = Boolean(marketing?.locked);
  const loading =
    publicationsQuery.isLoading || Boolean(selectedPublicationId && publicationQuery.isLoading);

  return (
    <div className={`overflow-x-clip ${micro.shell}`}>
      {section !== "write" ? (
        <>
          <AppHeader
            title="Email Marketing"
            afterTitle={
              <div aria-label="Publication controls" className="min-w-0 flex-1">
                <PublicationPicker
                  publications={publications}
                  selectedPublicationId={selectedPublicationId}
                  onSelectPublication={selectPublication}
                  onPublicationCreated={publicationCreated}
                  onOpenSettings={() => navigateSettings("details")}
                  locked={locked}
                  loading={publicationsQuery.isLoading}
                  loadError={queryError(publicationsQuery.error)}
                />
              </div>
            }
          />

          <div className="border-b border-black/[0.08] bg-white/95 backdrop-blur-xl">
            <div className="mx-auto max-w-7xl px-4 sm:px-6">
              <nav
                aria-label="Publication destinations"
                className="hidden min-w-0 items-center overflow-x-auto sm:flex"
              >
                {visibleSections.map((destination) => (
                  <button
                    key={destination}
                    type="button"
                    aria-current={destination === section ? "page" : undefined}
                    onClick={() => navigateSection(destination)}
                    className={`relative min-h-14 shrink-0 px-4 text-sm font-semibold outline-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3478f6]/30 ${
                      destination === section
                        ? "text-[#17213a] after:bg-[#17213a]"
                        : "text-[#17213a]/55 after:bg-transparent hover:text-[#17213a]"
                    }`}
                  >
                    {sectionLabels[destination]}
                  </button>
                ))}
              </nav>

              <label className="flex min-h-14 items-center gap-3 text-xs font-semibold text-[#17213a]/55 sm:hidden">
                <span className="shrink-0">Section</span>
                <select
                  aria-label="Email Marketing destination"
                  value={section}
                  onChange={(event) => navigateSection(event.target.value as EmailMarketingSection)}
                  className="min-w-0 flex-1 rounded-lg border border-black/[0.08] bg-white px-3 py-2.5 text-sm font-semibold text-[#17213a] outline-none focus:border-[#3478f6]/45"
                >
                  {visibleSections.map((destination) => (
                    <option key={destination} value={destination}>
                      {sectionLabels[destination]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </>
      ) : null}

      <main
        className={
          section === "write" ? "w-full p-2 sm:p-3" : "mx-auto w-full max-w-7xl px-4 sm:px-6"
        }
      >
        {section === "overview" ? (
          <EmailMarketingOverview
            publication={selectedData?.publication ?? null}
            creatorName={selectedData?.creatorUsername}
            subscriberCount={selectedSummary?.subscriberCount ?? 0}
            contactUsage={{
              subscribed: marketing?.contactUsage?.subscribed ?? 0,
              limit: marketing?.contactUsage?.limit ?? 500,
            }}
            posts={selectedData?.posts ?? []}
            locked={locked}
            loading={loading}
            error={selectedError}
            onSectionChange={navigateSection}
          />
        ) : !selectedData?.publication ? (
          <EmailMarketingOverview
            publication={null}
            creatorName={null}
            subscriberCount={0}
            contactUsage={{
              subscribed: marketing?.contactUsage?.subscribed ?? 0,
              limit: marketing?.contactUsage?.limit ?? 500,
            }}
            posts={[]}
            locked={locked}
            loading={loading}
            error={selectedError}
            onSectionChange={navigateSection}
          />
        ) : section === "posts" ? (
          requestedPostId &&
          selectedData.posts?.some(
            (post: NewsletterPostTableRecord) => post.id === requestedPostId,
          ) ? (
            <NewsletterPostDetail
              post={selectedData.posts.find(
                (post: NewsletterPostTableRecord) => post.id === requestedPostId,
              )!}
              publicationName={selectedData.publication.title}
              onBack={() => navigateSection("posts", null)}
              onEdit={() => navigateSection("write", requestedPostId)}
            />
          ) : (
            <NewsletterPostsTable
              posts={selectedData.posts ?? []}
              creatorUsername={selectedData.creatorUsername}
              publicationSlug={selectedData.publication.slug}
              publicOrigin={import.meta.env.VITE_PUBLIC_URL}
              onStartPost={() => navigateSection("write", null)}
              onOpenPost={(post) => navigateSection("posts", post.id)}
              onEdit={(post) => navigateSection("write", post.id)}
              onDuplicate={duplicatePost}
              onPreview={(post) => navigateSection("write", post.id)}
              onSchedule={(post) => navigateSection("write", post.id, "schedule")}
              onDeleteDraft={deleteDraft}
            />
          )
        ) : section === "templates" ? (
          <NewsletterTemplates
            defaultTemplateId={selectedData.publication.default_template_id ?? "editorial"}
            recentTemplateIds={(selectedData.posts ?? [])
              .map((post: NewsletterPostTableRecord) => post.template_id)
              .filter((id: NewsletterTemplateId | null | undefined): id is NewsletterTemplateId =>
                Boolean(id),
              )}
            onSetDefault={setDefaultTemplate}
            onStartPost={saveTemplateDraft}
          />
        ) : section === "broadcasts" ? (
          <div className="py-6">
            <EmailBroadcastsPanel
              key={selectedData.publication.id}
              publicationId={selectedData.publication.id}
              publicationName={selectedData.publication.title}
              campaigns={(marketing?.audienceCampaigns ?? []).filter(
                (campaign: { publication_id: string }) =>
                  campaign.publication_id === selectedData.publication.id,
              )}
              lists={(marketing?.audienceLists ?? []).filter(
                (list: { publication_id: string }) =>
                  list.publication_id === selectedData.publication.id,
              )}
              contacts={marketing?.audienceContacts ?? []}
              listMembers={marketing?.audienceListMembers ?? []}
              recipientCounts={recipientCountsQuery.data}
              locked={locked}
              onRefresh={refreshMarketing}
            />
          </div>
        ) : section === "website" ? (
          <div className="py-6">
            <NewsletterWebsite
              publication={selectedData.publication}
              archiveData={selectedData.websiteArchive}
              posts={selectedData.posts ?? []}
              bentoAdded={Boolean(selectedData.websiteArchive?.signupBlock)}
              onToggleBento={setPublicationOnBento}
              onSettings={navigateSettings}
              onTemplates={() => navigateSection("templates")}
              onEditPost={(postId) => navigateSection("write", postId)}
              publicOrigin={import.meta.env.VITE_PUBLIC_URL}
            />
          </div>
        ) : section === "settings" ? (
          <div className="py-6">
            <NewsletterSettings
              key={selectedData.publication.id}
              publication={selectedData.publication}
              creatorUsername={selectedData.creatorUsername}
              focusedPanel={requestedSettings}
              onFocusedPanelChange={navigateSettings}
              onSave={(input) =>
                updateNewsletterPublication({
                  data: {
                    publicationId: selectedData.publication.id,
                    title: input.title,
                    description: input.description ?? "",
                    senderName: input.sender_name,
                    replyToEmail: input.reply_to_email || null,
                    postalAddress: input.postal_address,
                    accentColor: input.accent_color || null,
                    logoUrl: input.logo_url || null,
                    defaultTemplateId: input.default_template_id,
                    status: input.status === "published" ? "published" : "draft",
                  },
                }).then(refreshPublication)
              }
              onSavePaidOffer={(input) =>
                savePaidNewsletterOffer({
                  data: { publicationId: selectedData.publication.id, ...input },
                }).then(refreshPublication)
              }
              onSetDefault={() =>
                setDefaultNewsletterPublication({
                  data: { publicationId: selectedData.publication.id },
                }).then(refreshPublication)
              }
              onArchive={(confirmation) =>
                archiveNewsletterPublication({
                  data: { publicationId: selectedData.publication.id, confirmation },
                }).then(refreshPublication)
              }
            />
          </div>
        ) : section === "subscribers" ? (
          <div className="py-6">
            <EmailAudiencePanel
              publication={{
                id: selectedData.publication.id,
                title: selectedData.publication.title,
              }}
              lists={marketing?.audienceLists ?? []}
              listMembers={marketing?.audienceListMembers ?? []}
              contactUsage={marketing?.contactUsage}
              locked={locked}
              onRefresh={refreshMarketing}
            />
          </div>
        ) : section === "write" && !requestedPostId ? (
          <NewsletterTemplates
            selectionMode
            defaultTemplateId={selectedData.publication.default_template_id ?? "editorial"}
            recentTemplateIds={(selectedData.posts ?? [])
              .map((post: NewsletterPostTableRecord) => post.template_id)
              .filter((id: NewsletterTemplateId | null | undefined): id is NewsletterTemplateId =>
                Boolean(id),
              )}
            onBack={() => navigateSection("posts", null)}
            onSetDefault={setDefaultTemplate}
            onStartPost={saveTemplateDraft}
          />
        ) : (
          <div className="py-6">
            <NewsletterWorkspace
              key={`${selectedData.publication.id}:${requestedPostId ?? "new"}`}
              publication={selectedData.publication}
              issues={selectedData.posts ?? []}
              products={selectedData.products ?? []}
              creatorUsername={selectedData.creatorUsername ?? null}
              selectedPostId={requestedPostId ?? null}
              recipientCounts={recipientCountsQuery.data}
              audiences={(marketing?.audienceLists ?? [])
                .filter(
                  (list: { publication_id: string }) =>
                    list.publication_id === selectedData.publication.id,
                )
                .map((list: { id: string; name: string }) => ({ id: list.id, name: list.name }))}
              locked={locked}
              onBack={() => navigateSection("posts", null)}
              onRefresh={refreshPublication}
            />
          </div>
        )}
      </main>
    </div>
  );
}
