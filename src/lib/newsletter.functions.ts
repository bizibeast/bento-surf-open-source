/* eslint-disable @typescript-eslint/no-explicit-any -- Newsletter tables are introduced by a pending migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { resolvePublicUsername } from "./username-alias.server";
import { nextEmptyGridRow } from "./grid-geometry";
import {
  recordEmailMarketingCapacityBlock,
  verifyNewsletterConfirmationToken,
} from "./email.server";
import { requirePlanEntitlement } from "./plan.server";
import { commerceProductPublishabilityError } from "./commerce";
import { uniqueProductSlug, uniquePublicProductSlug } from "./commerce.functions";
import { publicNewsletterPublicationPath, publicProductPath } from "./application-urls";
import { requireCreatorStorePaymentSetup } from "./payment-connection-policy.server";
import {
  newsletterContentSchema,
  newsletterPlainText,
  newsletterPublicSlug,
  safeNewsletterUrl,
  type NewsletterContentBlock,
} from "./newsletter";
import {
  uniquePublicationSlug,
  type NewsletterPublicationSummary,
} from "./newsletter-publications";
import { NEWSLETTER_TEMPLATE_IDS, resolveNewsletterTemplate } from "./newsletter-templates";

const uuid = z.string().uuid();

const newsletterPublicationStatus = z.enum(["draft", "published"]);
const newsletterTemplateId = z.enum(NEWSLETTER_TEMPLATE_IDS);
const newsletterPublicationInput = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000),
  senderName: z.string().trim().min(1).max(120),
  replyToEmail: z.string().trim().email().max(254).nullable().optional(),
  postalAddress: z.string().trim().min(1).max(500),
  accentColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable()
    .optional(),
  logoUrl: z.string().url().max(2_048).nullable().optional(),
  defaultTemplateId: newsletterTemplateId.default("editorial"),
  status: newsletterPublicationStatus.default("draft"),
});

function newsletterPublicationRow(data: z.infer<typeof newsletterPublicationInput>) {
  return {
    title: data.title,
    description: data.description,
    sender_name: data.senderName,
    reply_to_email: data.replyToEmail || null,
    postal_address: data.postalAddress,
    accent_color: data.accentColor || null,
    logo_url: data.logoUrl || null,
    default_template_id: data.defaultTemplateId,
    status: data.status,
    published_at: data.status === "published" ? new Date().toISOString() : null,
  };
}

function newsletterPublicationConstraint(error: any) {
  const detail = [error?.constraint, error?.message, error?.details, error?.hint].join(" ");
  if (detail.includes("newsletter_publications_one_default_per_creator")) return "default";
  if (detail.includes("newsletter_publications_creator_slug_unique")) return "slug";
  return null;
}

async function loadMyNewsletterPublication(db: any, creatorId: string, publicationId: string) {
  const { data: publication, error: publicationError } = await db
    .from("newsletter_publications")
    .select("*")
    .eq("id", publicationId)
    .eq("creator_id", creatorId)
    .maybeSingle();
  if (publicationError) throw new Error(publicationError.message);
  if (!publication) throw new Error("Newsletter publication not found.");

  const [postsResult, productsResult, profileResult, paidProductResult, signupResult] =
    await Promise.all([
      db
        .from("audience_campaigns")
        .select("*")
        .eq("creator_id", creatorId)
        .eq("publication_id", publicationId)
        .eq("kind", "newsletter")
        .order("created_at", { ascending: false }),
      db
        .from("commerce_products")
        .select("id,title,description,public_slug,price_amount,currency,billing_interval")
        .eq("creator_id", creatorId)
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("profiles")
        .select("id,username,display_name,accent_color,noindex,onboarded")
        .eq("id", creatorId)
        .maybeSingle(),
      publication.paid_product_id
        ? db
            .from("commerce_products")
            .select("*")
            .eq("id", publication.paid_product_id)
            .eq("creator_id", creatorId)
            .eq("kind", "newsletter")
            .eq("status", "published")
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      db
        .from("blocks")
        .select("id,content")
        .eq("user_id", creatorId)
        .eq("type", "email_capture")
        .contains("content", { newsletterPublicationId: publicationId })
        .limit(1)
        .maybeSingle(),
    ]);
  if (postsResult.error) throw new Error(postsResult.error.message);
  if (productsResult.error) throw new Error(productsResult.error.message);
  if (profileResult.error) throw new Error(profileResult.error.message);
  if (paidProductResult.error) throw new Error(paidProductResult.error.message);
  if (signupResult.error) throw new Error(signupResult.error.message);

  const websiteArchive = profileResult.data?.username
    ? publicNewsletterArchiveFromRows({
        canonicalUsername: profileResult.data.username,
        creator: profileResult.data,
        publication,
        issues: [...(postsResult.data ?? [])].sort((left, right) =>
          String(right.published_at ?? "").localeCompare(String(left.published_at ?? "")),
        ),
        paidProduct: paidProductResult.data,
        signupBlock: signupResult.data,
      })
    : null;

  return {
    publication: { ...publication, paidProduct: paidProductResult.data },
    posts: postsResult.data ?? [],
    products: productsResult.data ?? [],
    creatorUsername: profileResult.data?.username ?? null,
    websiteArchive,
  };
}

export const getMyNewsletterPublications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = supabaseAdmin as any;
    const { data: publications, error } = await db
      .from("newsletter_publications")
      .select("id,title,slug,logo_url,status,is_default")
      .eq("creator_id", context.userId)
      .neq("status", "archived")
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    if (!publications?.length) return [] as NewsletterPublicationSummary[];

    const { data: subscriptions, error: subscriptionsError } = await db
      .from("newsletter_subscriptions")
      .select("publication_id")
      .in(
        "publication_id",
        publications.map((publication: any) => publication.id),
      )
      .eq("status", "subscribed");
    if (subscriptionsError) throw new Error(subscriptionsError.message);
    const counts = new Map<string, number>();
    for (const subscription of subscriptions ?? []) {
      counts.set(subscription.publication_id, (counts.get(subscription.publication_id) ?? 0) + 1);
    }
    return publications.map((publication: any): NewsletterPublicationSummary => ({
      id: publication.id,
      title: publication.title,
      slug: publication.slug,
      logoUrl: publication.logo_url,
      status: publication.status,
      isDefault: publication.is_default,
      subscriberCount: counts.get(publication.id) ?? 0,
    }));
  });

export const getMyNewsletterPublication = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ publicationId: uuid }).parse(input))
  .handler(({ data, context }) =>
    loadMyNewsletterPublication(supabaseAdmin as any, context.userId, data.publicationId),
  );

export const createNewsletterPublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => newsletterPublicationInput.parse(input))
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      "Upgrade to use Email Marketing.",
    );
    const db = supabaseAdmin as any;
    const { data: existing, error: existingError } = await db
      .from("newsletter_publications")
      .select("slug")
      .eq("creator_id", context.userId);
    if (existingError) throw new Error(existingError.message);
    let slug = uniquePublicationSlug(
      data.title,
      (existing ?? []).map((publication: any) => publication.slug),
    );
    if (!slug) throw new Error("Publication title must include a letter or number.");
    let isDefault = !existing?.length;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await db
        .from("newsletter_publications")
        .insert({
          creator_id: context.userId,
          slug,
          is_default: isDefault,
          ...newsletterPublicationRow(data),
        })
        .select("*")
        .maybeSingle();
      if (!result.error) {
        if (!result.data) throw new Error("Publication could not be created.");
        return result.data;
      }
      if (result.error.code !== "23505") throw new Error(result.error.message);

      const constraint = newsletterPublicationConstraint(result.error);
      if (constraint === "default" && isDefault) {
        isDefault = false;
        continue;
      }
      if (constraint === "slug") {
        const { data: current, error: currentError } = await db
          .from("newsletter_publications")
          .select("slug")
          .eq("creator_id", context.userId);
        if (currentError) throw new Error(currentError.message);
        slug = uniquePublicationSlug(
          data.title,
          (current ?? []).map((publication: any) => publication.slug),
        );
        isDefault = isDefault && !current?.length;
        continue;
      }
      throw new Error(result.error.message);
    }
    throw new Error("Publication could not be created after resolving concurrent changes.");
  });

export const updateNewsletterPublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => newsletterPublicationInput.extend({ publicationId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      "Upgrade to use Email Marketing.",
    );
    const { publicationId, ...publicationInput } = data;
    const { data: publication, error } = await (supabaseAdmin as any)
      .from("newsletter_publications")
      .update(newsletterPublicationRow(publicationInput))
      .eq("id", publicationId)
      .eq("creator_id", context.userId)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!publication) throw new Error("Newsletter publication not found.");
    return publication;
  });

export const setDefaultNewsletterPublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ publicationId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: publication, error } = await (supabaseAdmin as any).rpc(
      "set_default_newsletter_publication",
      {
        p_creator_id: context.userId,
        p_publication_id: data.publicationId,
      },
    );
    if (error) throw new Error(error.message);
    if (!publication) throw new Error("Newsletter publication not found.");
    return publication;
  });

export const archiveNewsletterPublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        publicationId: uuid,
        confirmation: z.string().min(1).max(120),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: archived, error } = await (supabaseAdmin as any).rpc(
      "archive_newsletter_publication",
      {
        p_creator_id: context.userId,
        p_publication_id: data.publicationId,
        p_confirmation: data.confirmation,
      },
    );
    if (error) throw new Error(error.message);
    if (!archived) throw new Error("Newsletter publication not found.");
    return archived;
  });

export const getMyNewsletter = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = supabaseAdmin as any;
    const { data: publications, error } = await db
      .from("newsletter_publications")
      .select("id")
      .eq("creator_id", context.userId)
      .neq("status", "archived")
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    const publicationId = publications?.[0]?.id;
    if (!publicationId) {
      return {
        publication: null,
        posts: [],
        products: [],
        creatorUsername: null,
        websiteArchive: null,
      };
    }
    const loaded = await loadMyNewsletterPublication(db, context.userId, publicationId);
    return loaded;
  });

const paidNewsletterOfferSchema = z.object({
  publicationId: uuid,
  priceAmount: z.number().int().positive().max(100_000_000),
  currency: z
    .string()
    .trim()
    .regex(/^[a-z]{3}$/i)
    .transform((value) => value.toLowerCase()),
  billingInterval: z.enum(["month", "year"]),
});

export const savePaidNewsletterOffer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => paidNewsletterOfferSchema.parse(input))
  .handler(async ({ data, context }) => {
    const db = supabaseAdmin as any;
    const { data: publication, error: publicationError } = await db
      .from("newsletter_publications")
      .select("*")
      .eq("id", data.publicationId)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (publicationError) throw new Error(publicationError.message);
    if (!publication) throw new Error("Newsletter publication not found.");
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      "Upgrade to sell paid newsletter subscriptions.",
    );

    const paymentSetup = await requireCreatorStorePaymentSetup(context.userId);
    if (paymentSetup.selectedProvider !== "stripe") {
      throw new Error("Paid newsletters currently require Stripe.");
    }

    let productSlugs: { slug: string; publicSlug: string };
    if (publication.paid_product_id) {
      const { data: currentProduct, error: currentProductError } = await db
        .from("commerce_products")
        .select("slug,public_slug")
        .eq("id", publication.paid_product_id)
        .eq("creator_id", context.userId)
        .eq("kind", "newsletter")
        .maybeSingle();
      if (currentProductError) throw new Error(currentProductError.message);
      if (!currentProduct) throw new Error("Paid newsletter offer could not be loaded.");
      productSlugs = { slug: currentProduct.slug, publicSlug: currentProduct.public_slug };
    } else {
      const { data: profile, error: profileError } = await db
        .from("profiles")
        .select("username")
        .eq("id", context.userId)
        .maybeSingle();
      if (profileError) throw new Error(profileError.message);
      if (!profile?.username) throw new Error("Creator profile not found.");
      const title = `${publication.title} paid newsletter`;
      const [slug, publicSlug] = await Promise.all([
        uniqueProductSlug(db, profile.username, title),
        uniquePublicProductSlug(db, context.userId, title),
      ]);
      productSlugs = { slug, publicSlug };
    }
    const productInput = {
      creator_id: context.userId,
      kind: "newsletter" as const,
      status: "published" as const,
      slug: productSlugs.slug,
      public_slug: productSlugs.publicSlug,
      title: `${publication.title} paid newsletter`,
      subtitle: "Paid newsletter",
      description: publication.description || `Paid posts from ${publication.title}.`,
      cover_url: publication.cover_url || null,
      pricing_type: "subscription" as const,
      price_amount: data.priceAmount,
      currency: data.currency,
      billing_interval: data.billingInterval,
      cta_label: "Subscribe",
      settings: { newsletterPublicationId: publication.id },
      inventory_limit: null,
      noindex: false,
      published_at: new Date().toISOString(),
    };
    const reason = commerceProductPublishabilityError(productInput);
    if (reason) throw new Error(reason);

    const productQuery = publication.paid_product_id
      ? db
          .from("commerce_products")
          .update(productInput)
          .eq("id", publication.paid_product_id)
          .eq("creator_id", context.userId)
          .eq("kind", "newsletter")
      : db.from("commerce_products").insert(productInput);
    const { data: product, error: productError } = await productQuery.select("*").maybeSingle();
    if (productError) throw new Error(productError.message);
    if (!product) throw new Error("Paid newsletter offer could not be saved.");

    const { data: linkedPublication, error: linkError } = await db
      .from("newsletter_publications")
      .update({ paid_product_id: product.id })
      .eq("id", publication.id)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (linkError) throw new Error(linkError.message);
    if (!linkedPublication) throw new Error("Paid newsletter offer could not be linked.");
    return product;
  });

export async function hasPaidNewsletterAccess(input: { publicationId: string; email: string }) {
  const data = z
    .object({ publicationId: uuid, email: z.string().trim().email().max(254) })
    .parse(input);
  const db = supabaseAdmin as any;
  const { data: publication, error: publicationError } = await db
    .from("newsletter_publications")
    .select("paid_product_id")
    .eq("id", data.publicationId)
    .maybeSingle();
  if (publicationError) throw new Error(publicationError.message);
  if (!publication?.paid_product_id) return false;

  const { data: grant, error: grantError } = await db
    .from("commerce_access_grants")
    .select("status,expires_at")
    .eq("product_id", publication.paid_product_id)
    .eq("buyer_email", data.email.toLowerCase())
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (grantError) throw new Error(grantError.message);
  return Boolean(
    grant?.status === "active" &&
    (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now()),
  );
}

export const saveNewsletterPublication = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => newsletterPublicationInput.parse(input))
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      "Upgrade to use Email Marketing.",
    );
    const slug = uniquePublicationSlug(data.title, []);
    if (!slug) throw new Error("Publication title must include a letter or number.");
    const db = supabaseAdmin as any;
    const { data: publications, error: publicationsError } = await db
      .from("newsletter_publications")
      .select("id")
      .eq("creator_id", context.userId)
      .neq("status", "archived")
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1);
    if (publicationsError) throw new Error(publicationsError.message);
    const publicationId = publications?.[0]?.id;
    const row = newsletterPublicationRow(data);
    const query = publicationId
      ? db
          .from("newsletter_publications")
          .update(row)
          .eq("id", publicationId)
          .eq("creator_id", context.userId)
      : db.from("newsletter_publications").insert({
          creator_id: context.userId,
          slug,
          is_default: true,
          ...row,
        });
    const { data: publication, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!publication) throw new Error("Could not save newsletter publication.");
    return publication;
  });

export const saveNewsletterIssue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        id: uuid.optional(),
        publicationId: uuid,
        templateId: newsletterTemplateId.nullable().optional(),
        listId: uuid.nullable().optional(),
        name: z.string().trim().min(1).max(120),
        subject: z.string().trim().min(1).max(180),
        previewText: z.string().trim().max(240).default(""),
        publicSlug: z.string().trim().max(96).nullable().optional(),
        webVisibility: z.enum(["private", "public", "paid"]),
        content: newsletterContentSchema,
        status: z.enum(["draft", "published"]).default("draft"),
      })
      .superRefine((value, context) => {
        if (value.webVisibility !== "private" && !value.publicSlug) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["publicSlug"],
            message: "Public newsletter posts require a slug.",
          });
        }
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      "Upgrade to use Email Marketing.",
    );
    const db = supabaseAdmin as any;
    const { data: publication, error: publicationError } = await db
      .from("newsletter_publications")
      .select("id,postal_address,default_template_id")
      .eq("id", data.publicationId)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (publicationError) throw new Error(publicationError.message);
    if (!publication) throw new Error("Newsletter publication not found.");
    if (data.status === "published" && !publication.postal_address?.trim()) {
      throw new Error("Add a sender postal address before publishing.");
    }
    if (data.listId) {
      const { data: list, error: listError } = await db
        .from("audience_lists")
        .select("id")
        .eq("id", data.listId)
        .eq("creator_id", context.userId)
        .maybeSingle();
      if (listError) throw new Error(listError.message);
      if (!list) throw new Error("Audience list not found.");
    }

    const publicSlug = data.publicSlug ? newsletterPublicSlug(data.publicSlug) : null;
    if (data.publicSlug && !publicSlug)
      throw new Error("Post slug must include a letter or number.");

    const row = {
      creator_id: context.userId,
      list_id: data.listId || null,
      name: data.name,
      subject: data.subject,
      preview_text: data.previewText,
      body_markdown: newsletterPlainText(data.content),
      sender_postal_address: publication.postal_address,
      status: data.status,
      kind: "newsletter",
      publication_id: data.publicationId,
      public_slug: publicSlug,
      content: data.content,
      web_visibility: data.webVisibility,
      published_at: data.status === "published" ? new Date().toISOString() : null,
      scheduled_at: null,
      sent_at: null,
      ...(!data.id || data.templateId !== undefined
        ? { template_id: data.templateId ?? publication.default_template_id }
        : {}),
    };
    const query = data.id
      ? db
          .from("audience_campaigns")
          .update(row)
          .eq("id", data.id)
          .eq("creator_id", context.userId)
          .eq("status", "draft")
          .eq("kind", "newsletter")
      : db.from("audience_campaigns").insert(row);
    const { data: issue, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!issue) throw new Error("Only draft newsletter posts can be edited.");
    return issue;
  });

export const deleteNewsletterDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ id: uuid, publicationId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "emailMarketing",
      "Upgrade to use Email Marketing.",
    );
    const { data: deleted, error } = await (supabaseAdmin as any)
      .from("audience_campaigns")
      .delete()
      .eq("id", data.id)
      .eq("publication_id", data.publicationId)
      .eq("creator_id", context.userId)
      .eq("kind", "newsletter")
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!deleted) throw new Error("Draft not found.");
    return deleted;
  });

type PublicNewsletterRows = {
  canonicalUsername: string;
  creator: any;
  publication: any;
  issues: any[];
  paidProduct: any | null;
  products?: any[];
  signupBlock?: any | null;
};

type PublicNewsletterContentBlock =
  | Exclude<NewsletterContentBlock, { type: "product" }>
  | {
      id: string;
      type: "product";
      product: {
        title: string;
        description: string;
        url: string;
        priceAmount: number;
        currency: string;
        billingInterval: string | null;
      } | null;
    };

function publicPaidProduct(rows: PublicNewsletterRows) {
  const product = rows.paidProduct;
  return product &&
    product.id === rows.publication?.paid_product_id &&
    product.creator_id === rows.creator?.id &&
    product.kind === "newsletter" &&
    product.status === "published" &&
    typeof product.public_slug === "string" &&
    product.public_slug
    ? { title: String(product.title), publicSlug: String(product.public_slug) }
    : null;
}

function publicIssueSummary(issue: any, paidProduct: ReturnType<typeof publicPaidProduct>) {
  if (
    issue?.status !== "published" ||
    !issue.published_at ||
    !issue.public_slug ||
    !["public", "paid"].includes(issue.web_visibility) ||
    (issue.web_visibility === "paid" && !paidProduct)
  )
    return null;
  return {
    slug: String(issue.public_slug),
    subject: String(issue.name || issue.subject),
    previewText: String(issue.preview_text ?? ""),
    publishedAt: String(issue.published_at),
    visibility: issue.web_visibility as "public" | "paid",
    templateId: resolveNewsletterTemplate(issue.template_id)?.id ?? null,
  };
}

function publicNewsletterCreator(canonicalUsername: string, creator: any) {
  return {
    username: canonicalUsername,
    displayName: String(creator.display_name || canonicalUsername),
    avatarUrl: creator.avatar_url ?? null,
    bio: String(creator.bio ?? ""),
    theme: creator.theme === "dark" ? "dark" : "light",
    accentColor: creator.accent_color ?? null,
    primaryFont: creator.primary_font ?? null,
    secondaryFont: creator.secondary_font ?? null,
    pattern: creator.pattern ?? "none",
    patternSettings: creator.pattern_settings ?? null,
    noindex: creator.noindex === true,
    onboarded: creator.onboarded !== false,
  } as const;
}

export function publicNewsletterArchiveFromRows(rows: PublicNewsletterRows) {
  if (
    rows.publication?.status !== "published" ||
    rows.publication.creator_id !== rows.creator?.id ||
    !rows.publication.slug
  )
    return null;
  const paidProduct = publicPaidProduct(rows);
  return {
    creator: publicNewsletterCreator(rows.canonicalUsername, rows.creator),
    publication: {
      title: String(rows.publication.title),
      slug: String(rows.publication.slug),
      description: String(rows.publication.description ?? ""),
      accentColor: rows.publication.accent_color ?? null,
      logoUrl: rows.publication.logo_url ?? null,
      postalAddress: String(rows.publication.postal_address),
    },
    signupBlock: rows.signupBlock
      ? {
          id: String(rows.signupBlock.id),
          type: "email_capture" as const,
          content: {
            title: String(rows.signupBlock.content?.title || `Join ${rows.publication.title}`),
            subtitle: String(
              rows.signupBlock.content?.subtitle || rows.publication.description || "",
            ),
            buttonLabel: String(rows.signupBlock.content?.buttonLabel || "Subscribe"),
            tint: String(rows.signupBlock.content?.tint || "sky"),
            url: publicNewsletterPublicationPath(
              rows.canonicalUsername,
              String(rows.publication.slug),
            ),
          },
          w: 2,
          h: 2,
        }
      : null,
    paidProduct,
    issues: rows.issues
      .map((issue) => publicIssueSummary(issue, paidProduct))
      .filter((issue): issue is NonNullable<typeof issue> => Boolean(issue)),
  };
}

export function publicNewsletterIssueFromRows(rows: PublicNewsletterRows & { issueSlug: string }) {
  const archive = publicNewsletterArchiveFromRows(rows);
  if (!archive) return null;
  const rawIssue = rows.issues.find((issue) => issue.public_slug === rows.issueSlug);
  const paidProduct = publicPaidProduct(rows);
  const issue = publicIssueSummary(rawIssue, paidProduct);
  if (!issue) return null;
  if (issue.visibility === "paid") {
    return { ...archive, issue: { ...issue, content: null }, paidProduct };
  }
  const content = newsletterContentSchema.safeParse(rawIssue.content);
  if (!content.success) return null;
  const productById = new Map(
    (rows.products ?? [])
      .filter(
        (product) =>
          product.creator_id === rows.creator.id &&
          product.status === "published" &&
          typeof product.public_slug === "string" &&
          product.public_slug,
      )
      .map((product) => [product.id, product]),
  );
  const publicContent: PublicNewsletterContentBlock[] = [];
  for (const block of content.data) {
    if (block.type === "product") {
      const product = productById.get(block.productId);
      publicContent.push({
        id: block.id,
        type: "product",
        product: product
          ? {
              title: String(product.title),
              description: String(product.description ?? ""),
              url: publicProductPath(rows.canonicalUsername, String(product.public_slug)),
              priceAmount: Number(product.price_amount || 0),
              currency: String(product.currency || "usd").toLowerCase(),
              billingInterval:
                typeof product.billing_interval === "string" ? product.billing_interval : null,
            }
          : null,
      });
      continue;
    }
    if (
      (block.type === "image" || block.type === "button" || block.type === "social") &&
      !safeNewsletterUrl(block.url)
    )
      continue;
    publicContent.push(block);
  }
  return { ...archive, issue: { ...issue, content: publicContent }, paidProduct: null };
}

const publicNewsletterInput = z.object({
  username: z.string().trim().min(1).max(64),
  publicationSlug: z.string().trim().min(1).max(96).optional(),
});

async function loadPublicNewsletterRows(
  username: string,
  publicationSlug?: string,
): Promise<PublicNewsletterRows | null> {
  const db = supabaseAdmin as any;
  const resolved = await resolvePublicUsername(db, username);
  if (!resolved) return null;
  const { data: creator, error: creatorError } = await db
    .from("profiles")
    .select(
      "id,username,display_name,avatar_url,bio,theme,accent_color,primary_font,secondary_font,pattern,pattern_settings,noindex,onboarded",
    )
    .eq("id", resolved.userId)
    .maybeSingle();
  if (creatorError) throw new Error(creatorError.message);
  if (!creator) return null;
  let publicationQuery = db
    .from("newsletter_publications")
    .select(
      "id,creator_id,title,slug,description,logo_url,accent_color,postal_address,status,paid_product_id,is_default",
    )
    .eq("creator_id", resolved.userId)
    .eq("status", "published");
  publicationQuery = publicationSlug
    ? publicationQuery.eq("slug", publicationSlug)
    : publicationQuery.eq("is_default", true);
  const { data: publication, error: publicationError } = await publicationQuery.maybeSingle();
  if (publicationError) throw new Error(publicationError.message);
  if (!publication) return null;
  const { data: issues, error: issuesError } = await db
    .from("audience_campaigns")
    .select(
      "name,subject,preview_text,public_slug,web_visibility,status,published_at,template_id,content",
    )
    .eq("creator_id", resolved.userId)
    .eq("publication_id", publication.id)
    .eq("kind", "newsletter")
    .eq("status", "published")
    .not("published_at", "is", null)
    .in("web_visibility", ["public", "paid"])
    .order("published_at", { ascending: false });
  if (issuesError) throw new Error(issuesError.message);
  const [productsResult, signupResult] = await Promise.all([
    db
      .from("commerce_products")
      .select(
        "id,creator_id,status,title,description,public_slug,price_amount,currency,billing_interval",
      )
      .eq("creator_id", resolved.userId)
      .eq("status", "published")
      .limit(100),
    db
      .from("blocks")
      .select("id,content")
      .eq("user_id", resolved.userId)
      .eq("type", "email_capture")
      .contains("content", { newsletterPublicationId: publication.id })
      .limit(1)
      .maybeSingle(),
  ]);
  if (productsResult.error) throw new Error(productsResult.error.message);
  if (signupResult.error) throw new Error(signupResult.error.message);
  let paidProduct = null;
  if (publication.paid_product_id) {
    const result = await db
      .from("commerce_products")
      .select("id,creator_id,public_slug,title,kind,status")
      .eq("id", publication.paid_product_id)
      .eq("creator_id", resolved.userId)
      .eq("kind", "newsletter")
      .eq("status", "published")
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    paidProduct = result.data;
  }
  return {
    canonicalUsername: resolved.username,
    creator,
    publication,
    issues: issues ?? [],
    paidProduct,
    products: productsResult.data ?? [],
    signupBlock: signupResult.data ?? null,
  };
}

export const getPublicNewsletterPublications = createServerFn({ method: "GET" })
  .validator((input) => z.object({ username: z.string().trim().min(1).max(64) }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "public-newsletters");
    const db = supabaseAdmin as any;
    const resolved = await resolvePublicUsername(db, data.username);
    if (!resolved) return null;
    const [
      { data: creator, error: creatorError },
      { data: publications, error: publicationsError },
    ] = await Promise.all([
      db
        .from("profiles")
        .select(
          "id,username,display_name,avatar_url,bio,theme,accent_color,primary_font,secondary_font,pattern,pattern_settings,noindex,onboarded",
        )
        .eq("id", resolved.userId)
        .maybeSingle(),
      db
        .from("newsletter_publications")
        .select("title,slug,description,logo_url,accent_color,is_default")
        .eq("creator_id", resolved.userId)
        .eq("status", "published")
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true }),
    ]);
    if (creatorError || publicationsError) throw new Error("Unable to load public newsletters");
    if (!creator || !publications?.length) return null;
    return {
      creator: publicNewsletterCreator(resolved.username, creator),
      publications: publications.map((publication: any) => ({
        title: String(publication.title),
        slug: String(publication.slug),
        description: String(publication.description ?? ""),
        logoUrl: publication.logo_url ?? null,
        accentColor: publication.accent_color ?? null,
      })),
    };
  });

export const getPublicNewsletterArchive = createServerFn({ method: "GET" })
  .validator((input) => publicNewsletterInput.parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "public-newsletter");
    const rows = await loadPublicNewsletterRows(data.username, data.publicationSlug);
    return rows ? publicNewsletterArchiveFromRows(rows) : null;
  });

export const getPublicNewsletterIssue = createServerFn({ method: "GET" })
  .validator((input) =>
    publicNewsletterInput.extend({ issueSlug: z.string().trim().min(1).max(96) }).parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "public-newsletter-issue");
    const rows = await loadPublicNewsletterRows(data.username, data.publicationSlug);
    return rows ? publicNewsletterIssueFromRows({ ...rows, issueSlug: data.issueSlug }) : null;
  });

export const validateNewsletterSubscriptionConfirmation = createServerFn({ method: "GET" })
  .validator((input) => z.object({ token: z.string().min(1).max(2_048) }).parse(input))
  .handler(async ({ data }) => ({
    valid: Boolean(await verifyNewsletterConfirmationToken(data.token)),
  }));

export const confirmNewsletterSubscription = createServerFn({ method: "POST" })
  .validator((input) => z.object({ token: z.string().min(1).max(2_048) }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "newsletter-confirmation");
    const confirmation = await verifyNewsletterConfirmationToken(data.token);
    if (!confirmation) return { confirmed: false as const };
    const { data: confirmed, error } = await (supabaseAdmin as any).rpc(
      "confirm_public_newsletter_subscription",
      {
        p_publication_id: confirmation.publicationId,
        p_subscription_id: confirmation.subscriptionId,
        p_confirmation_nonce: confirmation.confirmationNonce,
        p_email: confirmation.email,
      },
    );
    if (error) {
      await recordEmailMarketingCapacityBlock({
        source: "newsletter_confirmation",
        error,
      });
      return { confirmed: false as const };
    }
    return { confirmed: Boolean(confirmed) };
  });

export const addNewsletterToBento = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ publicationId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePlanEntitlement(userId, "emailCollection", "Upgrade to add email capture.");
    const db = supabase as any;
    const { data: publication, error: publicationError } = await db
      .from("newsletter_publications")
      .select("id,title,slug,description,status")
      .eq("id", data.publicationId)
      .eq("creator_id", userId)
      .eq("status", "published")
      .maybeSingle();
    if (publicationError) throw new Error(publicationError.message);
    if (!publication) throw new Error("Publish your newsletter first.");
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("username")
      .eq("id", userId)
      .maybeSingle();
    if (profileError) throw new Error(profileError.message);
    if (!profile?.username) throw new Error("Creator profile not found.");
    const { data: blocks, error: blocksError } = await db
      .from("blocks")
      .select("id,type,content,y,h,position")
      .eq("user_id", userId)
      .is("page_id", null)
      .order("position", { ascending: true });
    if (blocksError) throw new Error(blocksError.message);
    const linked = blocks?.find(
      (block: any) =>
        block.type === "email_capture" &&
        block.content &&
        typeof block.content === "object" &&
        !Array.isArray(block.content) &&
        (block.content as Record<string, unknown>).newsletterPublicationId === publication.id,
    );
    const content = {
      ...((linked?.content as Record<string, unknown> | null) ?? {}),
      title: linked ? (linked.content as any)?.title : `Join ${publication.title}`,
      subtitle: linked
        ? (linked.content as any)?.subtitle
        : publication.description || "Get every new post in your inbox.",
      buttonLabel: linked ? (linked.content as any)?.buttonLabel : "Subscribe",
      newsletterPublicationId: publication.id,
      url: publicNewsletterPublicationPath(profile.username, publication.slug),
    };
    if (linked) {
      const { error } = await db
        .from("blocks")
        .update({ content })
        .eq("id", linked.id)
        .eq("user_id", userId);
      if (error) throw new Error(error.message);
      return { blockId: linked.id, created: false as const };
    }
    const { data: block, error } = await db
      .from("blocks")
      .insert({
        user_id: userId,
        type: "email_capture",
        content,
        cover_url: null,
        w: 2,
        h: 2,
        x: 0,
        y: nextEmptyGridRow(blocks ?? []),
        position: blocks?.length ?? 0,
        page_id: null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { blockId: block.id, created: true as const };
  });

export const removeNewsletterFromBento = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ publicationId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: publication, error: publicationError } = await (supabase as any)
      .from("newsletter_publications")
      .select("id")
      .eq("id", data.publicationId)
      .eq("creator_id", userId)
      .maybeSingle();
    if (publicationError) throw new Error(publicationError.message);
    if (!publication) throw new Error("Newsletter publication not found.");

    const { data: blocks, error: blocksError } = await (supabase as any)
      .from("blocks")
      .select("id,content")
      .eq("user_id", userId)
      .eq("type", "email_capture")
      .is("page_id", null);
    if (blocksError) throw new Error(blocksError.message);
    const ids = (blocks ?? [])
      .filter(
        (block: any) =>
          block.content &&
          typeof block.content === "object" &&
          !Array.isArray(block.content) &&
          block.content.newsletterPublicationId === publication.id,
      )
      .map((block: any) => block.id);
    if (!ids.length) return { removed: false as const };
    const { error } = await (supabase as any)
      .from("blocks")
      .delete()
      .eq("user_id", userId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    return { removed: true as const };
  });
