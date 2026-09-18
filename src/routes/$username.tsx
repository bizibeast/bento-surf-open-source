import { PublicSystemPageCanvas } from "@/components/public/PublicSystemPageCanvas";
import { PublicCreatorShell } from "@/components/public/PublicCreatorShell";
import { safeNavigationHref } from "@/lib/safe-url";
import { createFileRoute, notFound, Link, redirect, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { z } from "zod";
import { getPublicProfileForRequest } from "@/lib/profile.functions";
import { trackPublicEvent } from "@/lib/analytics";
import { publicPageHead } from "@/lib/open-graph";
import { normalizePlan, planHasEntitlement } from "@/lib/plans";
import {
  normalizePublicUsername,
  publicNewslettersPath,
  publicProfilePath,
} from "@/lib/application-urls";
import { openPublicCreatorPageFromWebMcp, useWebMcpTools, webMcpResult } from "@/lib/webmcp";

const profileQuery = (username: string, pageSlug: string | null) =>
  queryOptions({
    queryKey: ["public-profile", username, pageSlug],
    queryFn: () =>
      getPublicProfileForRequest({
        data: { segments: pageSlug ? [username, pageSlug] : [username] },
      }),
  });

export const Route = createFileRoute("/$username")({
  validateSearch: z.object({
    __bento_preview: z.string().optional(),
  }),
  loader: async ({ context, params, location }) => {
    const data = await context.queryClient.ensureQueryData(
      profileQuery(normalizePublicUsername(params.username), null),
    );
    if (!data) throw notFound();
    if (!data.customDomain && data.profile.username !== normalizePublicUsername(params.username)) {
      throw redirect({
        href: `${publicProfilePath(data.profile.username)}${location.searchStr}`,
        statusCode: 307,
      });
    }
    return data;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Not found" }] };
    return publicPageHead(loaderData, import.meta.env.VITE_PUBLIC_URL);
  },
  component: PublicProfileHome,
});

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <div className="font-display text-6xl">404</div>
        <p className="mt-2 text-muted-foreground">That bento doesn't exist.</p>
        <Link
          to="/"
          className="mt-4 inline-block rounded-lg bg-foreground px-4 py-2 text-sm text-background"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}

function PublicProfileHome() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const { data } = useSuspenseQuery(profileQuery(normalizePublicUsername(params.username), null));
  if (!data) return <NotFound />;
  return (
    <PublicProfileView
      data={data}
      username={data.profile.username}
      activeSlug={data.activePageSlug}
      previewMode={Boolean(search.__bento_preview)}
    />
  );
}

export function PublicProfileView({
  data,
  username,
  activeSlug,
  previewMode = false,
}: {
  data: NonNullable<Awaited<ReturnType<typeof getPublicProfileForRequest>>>;
  username: string;
  activeSlug: string | null;
  previewMode?: boolean;
}) {
  const navigate = useNavigate();
  const { profile, blocks, pages: visiblePages, customDomain } = data;
  const webMcpTools = useMemo(
    () => [
      {
        name: "bento_get_creator_page",
        title: "Get public Bento creator page",
        description:
          "Returns the public creator identity, active page, available pages, public blocks, and published social-insight summary visible in this tab.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () =>
          webMcpResult("Loaded the public creator page.", {
            creator: {
              username: profile.username,
              displayName: profile.display_name,
              bio: profile.bio,
              verified: Boolean(profile.is_pro),
            },
            activePage: activeSlug || "home",
            totalPages: visiblePages.length,
            pages: visiblePages.slice(0, 50).map((page) => ({
              id: page.id,
              name: page.name,
              slug: page.slug,
              href: page.href,
            })),
            totalBlocks: blocks.length,
            blocks: blocks.slice(0, 100).map(publicBlockSummary),
            socialInsights: data.socialInsights?.summary || null,
          }),
      },
      {
        name: "bento_open_creator_page",
        title: "Open public Bento page",
        description:
          "Opens one of the creator's visible internal Bento pages in this tab. External links are excluded.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              enum: [
                "home",
                ...visiblePages
                  .filter((page) => !page.url)
                  .map((page) => page.slug)
                  .filter((slug): slug is string => Boolean(slug)),
              ],
              description: "Visible Bento page slug, or home.",
            },
          },
          required: ["slug"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: (input: Record<string, unknown>, { signal }: { signal: AbortSignal }) =>
          openPublicCreatorPageFromWebMcp(input, visiblePages, signal, async (page) => {
            if (customDomain) {
              window.location.assign(page ? `/${page.slug}` : "/");
            } else if (page && "system" in page && page.system === "newsletter") {
              window.location.assign(publicNewslettersPath(profile.username));
            } else if (page) {
              await navigate({
                to: "/$username/$pageSlug",
                params: {
                  username: `@${normalizePublicUsername(username)}`,
                  pageSlug: page.slug,
                },
              });
            } else {
              await navigate({
                to: "/$username",
                params: { username: `@${normalizePublicUsername(username)}` },
              });
            }
          }),
      },
    ],
    [
      activeSlug,
      blocks,
      customDomain,
      data.socialInsights,
      navigate,
      profile,
      username,
      visiblePages,
    ],
  );
  useWebMcpTools(webMcpTools);
  useEffect(() => {
    if (!profile?.id) return;
    if (new URLSearchParams(window.location.search).has("__bento_preview")) return;
    let visitor_hash: string | undefined;
    try {
      const recentViewKey = `bs_recent_view:${profile.id}`;
      const recentView = Number(sessionStorage.getItem(recentViewKey));
      if (Number.isFinite(recentView) && Date.now() - recentView < 30_000) return;
      sessionStorage.setItem(recentViewKey, String(Date.now()));
      visitor_hash = localStorage.getItem("bs_vid") ?? undefined;
      if (!visitor_hash) {
        visitor_hash = crypto.randomUUID();
        localStorage.setItem("bs_vid", visitor_hash);
      }
    } catch {
      // Storage can be blocked by privacy settings; anonymous analytics still works.
    }
    trackPublicEvent({
      kind: "view",
      user_id: profile.id,
      visitor_hash,
      referrer: document.referrer.slice(0, 512),
    }).catch(() => {});
  }, [profile?.id]);

  return (
    <PublicCreatorShell chrome={data.chrome} activePageId={data.activePageId}>
      <PublicSystemPageCanvas
        username={profile.username}
        systemItems={data.systemItems}
        systemLayout={data.systemLayout}
        liveSocialEnabled={planHasEntitlement(
          normalizePlan(profile.plan_id, Boolean(profile.is_pro)),
          "liveSocialPreviews",
        )}
        blocks={blocks}
        previewMode={previewMode}
        onBlockClick={(blockId) => {
          let visitor_hash: string | undefined;
          try {
            visitor_hash = localStorage.getItem("bs_vid") ?? undefined;
          } catch {
            // Storage can be blocked by privacy settings; omit the visitor identifier.
          }
          trackPublicEvent({
            kind: "click",
            user_id: profile.id,
            block_id: blockId,
            visitor_hash,
            referrer: document.referrer.slice(0, 512),
          }).catch(() => {});
        }}
      />
    </PublicCreatorShell>
  );
}

function publicBlockSummary(block: { id: string; type: string; content: unknown }) {
  const content =
    block.content && typeof block.content === "object" && !Array.isArray(block.content)
      ? (block.content as Record<string, unknown>)
      : {};
  const firstText = [
    content.title,
    content.text,
    content.label,
    content.name,
    content.description,
  ].find((value) => typeof value === "string" && value.trim());
  return {
    id: block.id,
    type: block.type,
    title: typeof firstText === "string" ? firstText : null,
    url:
      typeof content.url === "string"
        ? safeNavigationHref(content.url, { allowRelative: true }) || null
        : null,
    productId: typeof content.productId === "string" ? content.productId : null,
  };
}
