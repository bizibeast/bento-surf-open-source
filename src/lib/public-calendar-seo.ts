import { publicProductUrl, publicProfileUrl } from "./application-urls";
import {
  creatorIndexingMeta,
  DEFAULT_OPEN_GRAPH_IMAGE_PATH,
  DEFAULT_OPEN_GRAPH_IMAGE_VERSION,
} from "./open-graph";
import { safePublicMediaUrl } from "./safe-url";
import { jsonLdScript } from "./seo-structured-data";

type PublicCalendarSeoData = {
  profile: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    noindex?: boolean | null;
    onboarded?: boolean | null;
  };
  pages: Array<{ name: string; system?: string }>;
  sessions: Array<{
    slug: string;
    title: string;
    subtitle: string;
    durationMinutes: number;
  }>;
};

export function publicCalendarHead(data: PublicCalendarSeoData, baseUrl?: string) {
  const canonical = publicProfileUrl(data.profile.username, "calendar", baseUrl);
  const base = new URL(canonical).origin;
  const creatorName = data.profile.displayName || data.profile.username;
  const calendarName = data.pages.find((page) => page.system === "calendar")?.name || "Calendar";
  const title = `Book ${creatorName} | bento.surf`;
  const description = data.sessions.length
    ? `Choose from ${data.sessions.length} bookable ${data.sessions.length === 1 ? "session" : "sessions"} with ${creatorName}.`
    : `View ${calendarName} for ${creatorName} on bento.surf.`;
  const avatar = safePublicMediaUrl(data.profile.avatarUrl);
  const image = avatar
    ? new URL(avatar, base).toString()
    : `${base}${DEFAULT_OPEN_GRAPH_IMAGE_PATH}?v=${DEFAULT_OPEN_GRAPH_IMAGE_VERSION}`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${calendarName} - ${creatorName}`,
    description,
    url: canonical,
    image,
    isPartOf: {
      "@type": "ProfilePage",
      name: creatorName,
      url: publicProfileUrl(data.profile.username, null, base),
    },
    ...(data.sessions.length
      ? {
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: data.sessions.length,
            itemListElement: data.sessions.map((session, index) => ({
              "@type": "ListItem",
              position: index + 1,
              item: {
                "@type": "Service",
                name: session.title,
                description:
                  session.subtitle ||
                  `${Math.max(1, Math.round(session.durationMinutes))}-minute session with ${creatorName}.`,
                duration: `PT${Math.max(1, Math.round(session.durationMinutes))}M`,
                url: publicProductUrl(data.profile.username, session.slug, base),
              },
            })),
          },
        }
      : {}),
  };

  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:type", content: "website" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: canonical },
      { property: "og:image", content: image },
      { property: "og:image:secure_url", content: image },
      { property: "og:image:alt", content: `${creatorName}'s booking calendar` },
      { name: "twitter:card", content: avatar ? "summary" : "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
      { name: "twitter:image:alt", content: `${creatorName}'s booking calendar` },
      ...creatorIndexingMeta(data.profile),
    ],
    links: [{ rel: "canonical", href: canonical }],
    scripts: [jsonLdScript(schema)],
  };
}
