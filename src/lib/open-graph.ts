import {
  configuredPublicOrigin,
  publicNewsletterPostPath,
  publicNewsletterPublicationPath,
  publicNewslettersPath,
  publicProductUrl,
  publicProfileUrl,
} from "./application-urls";
import { jsonLdScript } from "./seo-structured-data";
import { safePublicMediaUrl } from "./safe-url";

// Render the familiar 1200×630 Open Graph canvas at 2× density. Social networks
// can downsample the 2400×1260 source cleanly instead of stretching a 1× JPEG
// on high-density displays.
export const OPEN_GRAPH_VIEWPORT_WIDTH = 1_200;
export const OPEN_GRAPH_VIEWPORT_HEIGHT = 630;
export const OPEN_GRAPH_IMAGE_SCALE = 2;
export const OPEN_GRAPH_IMAGE_WIDTH = OPEN_GRAPH_VIEWPORT_WIDTH * OPEN_GRAPH_IMAGE_SCALE;
export const OPEN_GRAPH_IMAGE_HEIGHT = OPEN_GRAPH_VIEWPORT_HEIGHT * OPEN_GRAPH_IMAGE_SCALE;
// Bump this whenever the capture contract changes. The version is part of both
// the public image URL and the R2 key, so a broken immutable social preview can
// never survive a renderer fix.
export const OPEN_GRAPH_IMAGE_VERSION = "v12";

type PreviewProfile = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_url?: string | null;
  noindex?: boolean | null;
  onboarded?: boolean | null;
  meta_title?: string | null;
  meta_description?: string | null;
  updated_at: string;
};

type PreviewPage = {
  id: string;
  name?: string;
  slug: string;
  updated_at: string;
};

type PreviewBlock = {
  id: string;
  updated_at: string;
};

export type PublicPagePreviewData = {
  profile: PreviewProfile;
  pages: PreviewPage[];
  blocks: PreviewBlock[];
  activePageId: string | null;
  activePageSlug?: string | null;
  activePageName?: string | null;
};

export type PublicProductHeadData = {
  product: {
    slug: string;
    public_slug: string;
    title: string;
    subtitle: string | null;
    description: string | null;
    cover_url: string | null;
    pricing_type?: "free" | "one_time" | "subscription";
    price_amount?: number;
    currency?: string;
    billing_interval?: "day" | "week" | "month" | "year" | null;
    inventory_limit?: number | null;
    sales_count?: number;
    noindex?: boolean | null;
    published_at?: string | null;
  };
  creator: {
    username: string;
    display_name: string | null;
    noindex?: boolean | null;
    onboarded?: boolean | null;
  };
};

export function creatorIndexingMeta(profile: {
  noindex?: boolean | null;
  onboarded?: boolean | null;
}) {
  return profile.noindex === true || profile.onboarded === false
    ? [{ name: "robots", content: "noindex, nofollow, noarchive" }]
    : [];
}

export const DEFAULT_OPEN_GRAPH_IMAGE_PATH = "/branding/bento-logo.png";
export const DEFAULT_OPEN_GRAPH_IMAGE_VERSION = "20260813";

function publicBaseUrl(value?: string) {
  return configuredPublicOrigin(value);
}

function metadataDescription(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 200) return normalized;
  return `${normalized.slice(0, 197).trimEnd()}…`;
}

function newsletterMetadataText(value: string) {
  return metadataDescription(value.replace(/<[^>]*>/g, " "));
}

function absolutePublicPath(path: string, baseUrl?: string) {
  return `${publicBaseUrl(baseUrl)}${path}`;
}

export function publicNewsletterDirectoryHead(
  data: {
    creator: {
      username: string;
      displayName: string;
      noindex?: boolean;
      onboarded?: boolean;
    };
    publications: Array<{ title: string }>;
  },
  baseUrl?: string,
) {
  const title = newsletterMetadataText(`Newsletters by ${data.creator.displayName}`);
  const description = newsletterMetadataText(
    `Read ${data.publications.map((publication) => publication.title).join(", ")}.`,
  );
  const canonical = absolutePublicPath(publicNewslettersPath(data.creator.username), baseUrl);
  return {
    meta: [
      { title },
      { name: "description", content: description },
      {
        name: "robots",
        content:
          data.creator.noindex || data.creator.onboarded === false
            ? "noindex, nofollow, noarchive"
            : "index, follow",
      },
      { property: "og:type", content: "website" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: canonical },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [{ rel: "canonical", href: canonical }],
  };
}

export function publicNewsletterArchiveHead(
  data: {
    creator: {
      username: string;
      displayName: string;
      noindex?: boolean;
      onboarded?: boolean;
    };
    publication: { title: string; slug: string; description: string };
  },
  baseUrl?: string,
) {
  const title = newsletterMetadataText(`${data.publication.title} | ${data.creator.displayName}`);
  const description = newsletterMetadataText(
    data.publication.description || `Newsletter from ${data.creator.displayName}.`,
  );
  const canonical = absolutePublicPath(
    publicNewsletterPublicationPath(data.creator.username, data.publication.slug),
    baseUrl,
  );
  return {
    meta: [
      { title },
      { name: "description", content: description },
      {
        name: "robots",
        content:
          data.creator.noindex || data.creator.onboarded === false
            ? "noindex, nofollow, noarchive"
            : "index, follow",
      },
      { property: "og:type", content: "website" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: canonical },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [{ rel: "canonical", href: canonical }],
  };
}

export function publicNewsletterIssueHead(
  data: {
    creator: {
      username: string;
      displayName: string;
      noindex?: boolean;
      onboarded?: boolean;
    };
    publication: { title: string; slug: string };
    issue: {
      slug: string;
      subject: string;
      previewText: string;
      visibility: "public" | "paid";
    };
  },
  baseUrl?: string,
) {
  const title = newsletterMetadataText(`${data.issue.subject} | ${data.publication.title}`);
  const description = newsletterMetadataText(
    data.issue.previewText || `A post from ${data.publication.title}.`,
  );
  const canonical = absolutePublicPath(
    publicNewsletterPostPath(data.creator.username, data.publication.slug, data.issue.slug),
    baseUrl,
  );
  return {
    meta: [
      { title },
      { name: "description", content: description },
      {
        name: "robots",
        content:
          data.issue.visibility === "paid" ||
          data.creator.noindex ||
          data.creator.onboarded === false
            ? "noindex, nofollow, noarchive"
            : "index, follow",
      },
      { property: "og:type", content: "article" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: canonical },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [{ rel: "canonical", href: canonical }],
  };
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(36);
}

export function publicPagePreviewVersion(data: PublicPagePreviewData) {
  const seed = [
    OPEN_GRAPH_IMAGE_VERSION,
    data.profile.id,
    data.profile.updated_at,
    data.activePageId ?? "main",
    ...data.pages.map((page) => `${page.id}:${page.slug}:${page.updated_at}`),
    ...data.blocks.map((block) => `${block.id}:${block.updated_at}`),
  ].join("|");
  return `${OPEN_GRAPH_IMAGE_VERSION}-${fnv1a64(seed)}`;
}

export function publicPageSlug(data: PublicPagePreviewData) {
  if (data.activePageSlug) return data.activePageSlug;
  if (!data.activePageId) return null;
  return data.pages.find((page) => page.id === data.activePageId)?.slug ?? null;
}

export function publicPageCanonicalUrl(data: PublicPagePreviewData, baseUrl?: string) {
  const base = publicBaseUrl(baseUrl);
  const slug = publicPageSlug(data);
  return `${base}/@${encodeURIComponent(data.profile.username)}${slug ? `/${encodeURIComponent(slug)}` : ""}`;
}

export function publicPageOpenGraphImageUrl(data: PublicPagePreviewData, baseUrl?: string) {
  const base = publicBaseUrl(baseUrl);
  const slug = publicPageSlug(data);
  const path = `${encodeURIComponent(data.profile.username)}${slug ? `/${encodeURIComponent(slug)}` : ""}`;
  return `${base}/api/og/${path}.jpg?v=${encodeURIComponent(publicPagePreviewVersion(data))}`;
}

export function publicPageHead(data: PublicPagePreviewData, baseUrl?: string) {
  const creatorName = data.profile.display_name || data.profile.username;
  const pageSlug = publicPageSlug(data);
  const activePage = data.pages.find((page) => page.id === data.activePageId);
  const pageName = data.activePageName || activePage?.name || null;
  const title = pageSlug
    ? pageSlug === "insights"
      ? `Social Media Insights for ${creatorName} | bento.surf`
      : `${pageName || pageSlug} by ${creatorName} | bento.surf`
    : data.profile.meta_title?.trim() || `${creatorName} | bento.surf`;
  const description = metadataDescription(
    pageSlug
      ? pageSlug === "insights"
        ? `View public social media performance and audience insights for ${creatorName} on bento.surf.`
        : `Explore ${pageName || pageSlug} from ${creatorName} on bento.surf.${data.profile.bio ? ` ${data.profile.bio}` : ""}`
      : data.profile.meta_description?.trim() ||
          data.profile.bio ||
          `Find ${data.profile.username} on bento.surf.`,
  );
  const image = publicPageOpenGraphImageUrl(data, baseUrl);
  const canonical = publicPageCanonicalUrl(data, baseUrl);
  const imageAlt = `${creatorName}'s bento.surf page`;
  const avatar = safePublicMediaUrl(data.profile.avatar_url);
  const profileUrl = publicProfileUrl(data.profile.username, null, baseUrl);
  const personSchema = {
    "@type": "Person",
    "@id": `${profileUrl}#creator`,
    name: creatorName,
    alternateName: `@${data.profile.username}`,
    description: data.profile.bio || `Find ${data.profile.username} on bento.surf.`,
    url: profileUrl,
    ...(avatar ? { image: new URL(avatar, publicBaseUrl(baseUrl)).toString() } : {}),
  };
  const modifiedAt =
    pageSlug === "insights"
      ? null
      : [
          data.profile.updated_at,
          activePage?.updated_at,
          ...data.blocks.map((block) => block.updated_at),
        ]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) || null;
  const pageSchema = {
    "@context": "https://schema.org",
    "@type": pageSlug ? "WebPage" : "ProfilePage",
    name: title,
    description,
    url: canonical,
    ...(modifiedAt ? { dateModified: modifiedAt } : {}),
    ...(pageSlug
      ? {
          isPartOf: {
            "@type": "ProfilePage",
            "@id": `${profileUrl}#profile`,
            url: profileUrl,
          },
          about: personSchema,
        }
      : { "@id": `${profileUrl}#profile`, mainEntity: personSchema }),
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
      { property: "og:image:type", content: "image/jpeg" },
      { property: "og:image:width", content: String(OPEN_GRAPH_IMAGE_WIDTH) },
      { property: "og:image:height", content: String(OPEN_GRAPH_IMAGE_HEIGHT) },
      { property: "og:image:alt", content: imageAlt },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
      { name: "twitter:image:alt", content: imageAlt },
      ...creatorIndexingMeta(data.profile),
    ],
    links: [
      { rel: "canonical", href: canonical },
      ...(data.profile.avatar_url
        ? [{ rel: "preload", as: "image", href: data.profile.avatar_url }]
        : []),
    ],
    scripts: [jsonLdScript(pageSchema)],
  };
}

export function publicProductHead(data: PublicProductHeadData, baseUrl?: string) {
  const base = publicBaseUrl(baseUrl);
  const creatorName = data.creator.display_name || data.creator.username;
  const title = `${data.product.title} by ${creatorName} | bento.surf`;
  const description = metadataDescription(
    data.product.subtitle ||
      data.product.description ||
      `Buy ${data.product.title} from ${creatorName} on bento.surf.`,
  );
  const canonical = publicProductUrl(data.creator.username, data.product.public_slug, base);
  const cover = data.product.cover_url?.trim() || null;
  const imageAlt = `${data.product.title} by ${creatorName}`;
  const price =
    typeof data.product.price_amount === "number" && Number.isFinite(data.product.price_amount)
      ? (Math.max(0, data.product.price_amount) / 100).toFixed(2)
      : null;
  const currency = /^[a-z]{3}$/i.test(data.product.currency || "")
    ? data.product.currency!.toUpperCase()
    : null;
  const productSchema =
    cover && price !== null && currency
      ? {
          "@context": "https://schema.org",
          "@type": "Product",
          name: data.product.title,
          description,
          image: cover,
          url: canonical,
          offers: {
            "@type": "Offer",
            url: canonical,
            price,
            priceCurrency: currency,
            availability:
              data.product.inventory_limit !== null &&
              typeof data.product.inventory_limit === "number" &&
              data.product.inventory_limit > 0 &&
              (data.product.sales_count || 0) >= data.product.inventory_limit
                ? "https://schema.org/OutOfStock"
                : "https://schema.org/InStock",
            seller: {
              "@type": "Person",
              name: creatorName,
              url: publicProfileUrl(data.creator.username, null, base),
            },
            ...(data.product.billing_interval
              ? {
                  priceSpecification: {
                    "@type": "UnitPriceSpecification",
                    price,
                    priceCurrency: currency,
                    unitText: data.product.billing_interval.toUpperCase(),
                  },
                }
              : {}),
          },
        }
      : null;

  const imageMeta = cover
    ? [
        { property: "og:image", content: cover },
        { property: "og:image:secure_url", content: cover },
        { property: "og:image:alt", content: imageAlt },
        { name: "twitter:image", content: cover },
        { name: "twitter:image:alt", content: imageAlt },
      ]
    : [];

  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:type", content: "product" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: canonical },
      ...imageMeta,
      { name: "twitter:card", content: cover ? "summary_large_image" : "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      ...creatorIndexingMeta({
        noindex: data.product.noindex === true || data.creator.noindex === true,
        onboarded: data.creator.onboarded,
      }),
    ],
    links: [{ rel: "canonical", href: canonical }],
    scripts: productSchema ? [jsonLdScript(productSchema)] : [],
  };
}
