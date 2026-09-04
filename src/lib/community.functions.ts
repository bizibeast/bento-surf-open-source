import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Community columns are introduced by the pending staging migration; remove after regenerating Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, Tables } from "@/integrations/supabase/types";
import { normalizeCommunityResources } from "./community-member";
import { enqueueEmail, enqueueEmailBatch } from "./email.server";
import { getPlan, requirePlanEntitlement } from "./plan.server";
import { planHasEntitlement } from "./plans";

const uuidSchema = z.string().uuid();
const communityProductKinds = ["paid_community", "membership"] as const;
type CommunityProductRow = Tables<"commerce_products">;
type CommerceOrderRow = Tables<"commerce_orders">;
type AccessGrantSummary = {
  id: string;
  order_id: string | null;
  product_id: string;
  buyer_email: string;
  member_name: string | null;
  source: "purchase" | "manual";
  status: "active" | "revoked" | "expired";
  expires_at: string | null;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
  community_role: "member" | "moderator";
  community_notifications_enabled: boolean;
};

function jsonObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

export function randomCommunityAccessToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function communityTokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function creatorCommunityProduct(userId: string, productId: string) {
  const { data, error } = await supabaseAdmin
    .from("commerce_products")
    .select("*")
    .eq("id", productId)
    .eq("creator_id", userId)
    .in("kind", [...communityProductKinds])
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Community not found.");
  return data;
}

export async function creatorCommunityIdentity(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("username, display_name")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    name: data?.display_name || data?.username || "The creator",
    username: data?.username || "",
  };
}

export async function queueCommunityInvite(input: {
  grantId: string;
  token: string;
  email: string;
  memberName?: string | null;
  productTitle: string;
  creatorName: string;
}) {
  return enqueueEmail({
    eventKey: `community-invite:${input.grantId}:${(await communityTokenHash(input.token)).slice(0, 16)}`,
    eventType: "community_invite",
    recipientEmail: input.email,
    recipientName: input.memberName,
    payload: {
      productTitle: input.productTitle,
      creatorName: input.creatorName,
      accessUrl: `${appUrl()}/access/${encodeURIComponent(input.token)}`,
    },
    immediate: true,
  });
}

export async function notifyCommunityMembers(input: {
  product: CommunityProductRow;
  creatorName: string;
  postId: string;
  body: string;
}) {
  const database = supabaseAdmin as any;
  const preview = input.body.replace(/\s+/g, " ").slice(0, 240);
  const pageSize = 500;
  let offset = 0;
  let notified = 0;
  let emailsQueued = 0;

  // Page through every active grant so large communities are never silently
  // truncated. Writes stay bounded to keep request and PostgREST payloads small.
  while (true) {
    const { data: grants, error } = await database
      .from("commerce_access_grants")
      .select("id, buyer_email, member_name, community_notifications_enabled")
      .eq("creator_id", input.product.creator_id)
      .eq("product_id", input.product.id)
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!grants?.length) break;

    const { error: notificationError } = await database
      .from("commerce_community_notifications")
      .insert(
        grants.map((grant: { id: string }) => ({
          product_id: input.product.id,
          creator_id: input.product.creator_id,
          access_grant_id: grant.id,
          post_id: input.postId,
          kind: "creator_post",
          title: `New in ${input.product.title}`,
          body: preview,
        })),
      );
    if (notificationError) throw new Error(notificationError.message);

    const emailResult = await enqueueEmailBatch(
      grants
        .filter(
          (grant: { community_notifications_enabled: boolean }) =>
            grant.community_notifications_enabled,
        )
        .map(
          (grant: {
            id: string;
            buyer_email: string;
            member_name: string | null;
            community_notifications_enabled: boolean;
          }) => ({
            eventKey: `community-update:${input.postId}:${grant.id}`,
            eventType: "community_update" as const,
            recipientEmail: grant.buyer_email,
            recipientName: grant.member_name,
            payload: {
              productTitle: input.product.title,
              creatorName: input.creatorName,
              preview,
              accessUrl: `${appUrl()}/library`,
            },
            immediate: true,
          }),
        ),
    );
    notified += grants.length;
    emailsQueued += emailResult.rows.length;
    if (grants.length < pageSize) break;
    offset += pageSize;
  }

  return { notified, emailsQueued };
}

export const getCommunityWorkspace = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        productId: uuidSchema.optional(),
      })
      .optional()
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const database = supabaseAdmin;
    const communityDb = database as any;
    const [plan, { data: products, error: productsError }, identity] = await Promise.all([
      getPlan(context.userId),
      database
        .from("commerce_products")
        .select("*")
        .eq("creator_id", context.userId)
        .in("kind", [...communityProductKinds])
        .neq("status", "archived")
        .order("created_at", { ascending: false }),
      creatorCommunityIdentity(context.userId),
    ]);
    if (productsError) throw new Error(productsError.message);

    const selected =
      products?.find((product) => product.id === data?.productId) ?? products?.[0] ?? null;
    if (!selected) {
      return {
        plan,
        locked: !planHasEntitlement(plan, "communities"),
        products: products ?? [],
        creatorUsername: identity.username,
        selected: null,
        members: [],
        posts: [],
        comments: [],
        stats: { activeMembers: 0, paidMembers: 0, invitedMembers: 0, posts: 0, comments: 0 },
      };
    }

    const [
      { data: grants, error: grantsError },
      { data: posts, error: postsError },
      { data: comments, error: commentsError },
    ] = await Promise.all([
      communityDb
        .from("commerce_access_grants")
        .select(
          "id, order_id, product_id, buyer_email, member_name, source, status, expires_at, last_accessed_at, created_at, updated_at, community_role, community_notifications_enabled",
        )
        .eq("creator_id", context.userId)
        .eq("product_id", selected.id)
        .order("created_at", { ascending: false }),
      communityDb
        .from("commerce_community_posts")
        .select(
          "id, author_kind, author_name, body, is_pinned, resources, moderation_status, moderation_reason, created_at, updated_at",
        )
        .eq("creator_id", context.userId)
        .eq("product_id", selected.id)
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(200),
      communityDb
        .from("commerce_community_comments")
        .select(
          "id, post_id, author_kind, author_name, body, moderation_status, moderation_reason, created_at, updated_at",
        )
        .eq("creator_id", context.userId)
        .eq("product_id", selected.id)
        .order("created_at", { ascending: true })
        .limit(1_000),
    ]);
    if (grantsError) throw new Error(grantsError.message);
    if (postsError) throw new Error(postsError.message);
    if (commentsError) throw new Error(commentsError.message);

    const grantRows = (grants ?? []) as AccessGrantSummary[];
    const orderIds = grantRows
      .map((grant) => grant.order_id)
      .filter((value: unknown): value is string => typeof value === "string");
    const { data: orders, error: ordersError } = orderIds.length
      ? await database
          .from("commerce_orders")
          .select("id, buyer_name, provider, gross_amount, currency, status")
          .eq("creator_id", context.userId)
          .in("id", orderIds)
      : { data: [], error: null };
    if (ordersError) throw new Error(ordersError.message);
    const ordersById = new Map<string, CommerceOrderRow>(
      (orders ?? []).map((order) => [order.id, order as CommerceOrderRow]),
    );
    const members = grantRows.map((grant) => {
      const order = grant.order_id ? ordersById.get(grant.order_id) : undefined;
      return {
        ...grant,
        member_name: grant.member_name || order?.buyer_name || null,
        source: grant.source || (grant.order_id ? "purchase" : "manual"),
        order: grant.order_id ? order || null : null,
      };
    });

    return {
      plan,
      locked: !planHasEntitlement(plan, "communities"),
      products: products ?? [],
      creatorUsername: identity.username,
      selected,
      members,
      posts: posts ?? [],
      comments: comments ?? [],
      stats: {
        activeMembers: members.filter((member) => member.status === "active").length,
        paidMembers: members.filter((member) => member.source === "purchase").length,
        invitedMembers: members.filter((member) => member.source === "manual").length,
        posts: posts?.length ?? 0,
        comments:
          comments?.filter((comment: any) => comment.moderation_status === "published").length ?? 0,
      },
    };
  });

export const inviteCommunityMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        email: z.string().trim().email().max(254),
        name: z.string().trim().max(120).optional(),
        role: z.enum(["member", "moderator"]).default("member"),
        notificationsEnabled: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    const database = supabaseAdmin;
    const product = await creatorCommunityProduct(context.userId, data.productId);
    const identity = await creatorCommunityIdentity(context.userId);
    const email = data.email.toLowerCase();
    const token = randomCommunityAccessToken();
    const hashed = await communityTokenHash(token);
    const { data: existing, error: existingError } = await database
      .from("commerce_access_grants")
      .select("id")
      .eq("creator_id", context.userId)
      .eq("product_id", product.id)
      .is("order_id", null)
      .eq("buyer_email", email)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);

    const values = {
      creator_id: context.userId,
      product_id: product.id,
      order_id: null,
      buyer_email: email,
      member_name: data.name || null,
      source: "manual",
      token_hash: hashed,
      status: "active",
      expires_at: null,
      last_accessed_at: null,
      community_role: data.role,
      community_notifications_enabled: data.notificationsEnabled,
    };
    const { data: grant, error } = existing
      ? await (database as any)
          .from("commerce_access_grants")
          .update(values)
          .eq("id", existing.id)
          .eq("creator_id", context.userId)
          .select("id")
          .single()
      : await (database as any).from("commerce_access_grants").insert(values).select("id").single();
    if (error || !grant) throw new Error(error?.message || "Member access could not be created.");

    let emailQueued = true;
    try {
      await queueCommunityInvite({
        grantId: grant.id,
        token,
        email,
        memberName: data.name,
        productTitle: product.title,
        creatorName: identity.name,
      });
    } catch (emailError) {
      emailQueued = false;
      console.error("[community] invite email deferred", emailError);
    }
    return { id: grant.id, emailQueued };
  });

export const setCommunityMemberStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        grantId: uuidSchema,
        status: z.enum(["active", "revoked"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    const database = supabaseAdmin;
    const { data: grant, error: grantError } = await database
      .from("commerce_access_grants")
      .select("id, product_id, buyer_email, member_name")
      .eq("id", data.grantId)
      .eq("creator_id", context.userId)
      .maybeSingle();
    if (grantError) throw new Error(grantError.message);
    if (!grant) throw new Error("Member not found.");
    const product = await creatorCommunityProduct(context.userId, grant.product_id);

    if (data.status === "revoked") {
      const { error } = await database
        .from("commerce_access_grants")
        .update({ status: "revoked" })
        .eq("id", grant.id)
        .eq("creator_id", context.userId);
      if (error) throw new Error(error.message);
      return { status: "revoked", emailQueued: false };
    }

    const token = randomCommunityAccessToken();
    const { error } = await database
      .from("commerce_access_grants")
      .update({
        status: "active",
        token_hash: await communityTokenHash(token),
        expires_at: null,
        last_accessed_at: null,
      })
      .eq("id", grant.id)
      .eq("creator_id", context.userId);
    if (error) throw new Error(error.message);
    const identity = await creatorCommunityIdentity(context.userId);
    let emailQueued = true;
    try {
      await queueCommunityInvite({
        grantId: grant.id,
        token,
        email: grant.buyer_email,
        memberName: grant.member_name,
        productTitle: product.title,
        creatorName: identity.name,
      });
    } catch (emailError) {
      emailQueued = false;
      console.error("[community] restored access email deferred", emailError);
    }
    return { status: "active", emailQueued };
  });

export const updateCommunityMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        grantId: uuidSchema,
        role: z.enum(["member", "moderator"]),
        notificationsEnabled: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    const database = supabaseAdmin as any;
    const { data: grant, error } = await database
      .from("commerce_access_grants")
      .update({
        community_role: data.role,
        community_notifications_enabled: data.notificationsEnabled,
      })
      .eq("id", data.grantId)
      .eq("creator_id", context.userId)
      .select("id, community_role, community_notifications_enabled")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!grant) throw new Error("Member not found.");
    return grant;
  });

export const createCreatorCommunityPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        body: z.string().trim().min(1).max(10_000),
        pinned: z.boolean().default(false),
        resources: z
          .array(
            z.object({
              label: z.string().trim().max(80),
              url: z.string().trim().max(2_000),
            }),
          )
          .max(5)
          .default([]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    const product = await creatorCommunityProduct(context.userId, data.productId);
    const identity = await creatorCommunityIdentity(context.userId);
    const resources = normalizeCommunityResources(data.resources);
    if (
      resources.length !==
      data.resources.filter((resource) => resource.label && resource.url).length
    ) {
      throw new Error("Every resource must have a label and a secure HTTPS URL.");
    }
    const { data: post, error } = await (supabaseAdmin as any)
      .from("commerce_community_posts")
      .insert({
        product_id: product.id,
        creator_id: context.userId,
        access_grant_id: null,
        author_kind: "creator",
        author_name: identity.name,
        body: data.body,
        is_pinned: data.pinned,
        resources,
      })
      .select(
        "id, author_kind, author_name, body, is_pinned, resources, moderation_status, moderation_reason, created_at, updated_at",
      )
      .single();
    if (error || !post) throw new Error(error?.message || "Post could not be published.");
    let notificationResult = { notified: 0, emailsQueued: 0 };
    try {
      notificationResult = await notifyCommunityMembers({
        product,
        creatorName: identity.name,
        postId: post.id,
        body: data.body,
      });
    } catch (notificationError) {
      console.error("[community] update notification deferred", notificationError);
    }
    return { ...post, notificationResult };
  });

export const setCommunityPostPinned = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ postId: uuidSchema, productId: uuidSchema, pinned: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    await creatorCommunityProduct(context.userId, data.productId);
    const { data: post, error } = await supabaseAdmin
      .from("commerce_community_posts")
      .update({ is_pinned: data.pinned })
      .eq("id", data.postId)
      .eq("product_id", data.productId)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!post) throw new Error("Post not found.");
    return { id: post.id, pinned: data.pinned };
  });

export const deleteCommunityPost = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ postId: uuidSchema, productId: uuidSchema }).parse(input))
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    await creatorCommunityProduct(context.userId, data.productId);
    const { data: deletedPost, error } = await supabaseAdmin
      .from("commerce_community_posts")
      .delete()
      .eq("id", data.postId)
      .eq("product_id", data.productId)
      .eq("creator_id", context.userId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!deletedPost) throw new Error("Post not found.");
    return { id: deletedPost.id };
  });

export const createCreatorCommunityComment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        postId: uuidSchema,
        body: z.string().trim().min(1).max(3_000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    const product = await creatorCommunityProduct(context.userId, data.productId);
    const identity = await creatorCommunityIdentity(context.userId);
    const { data: post, error: postError } = await (supabaseAdmin as any)
      .from("commerce_community_posts")
      .select("id, access_grant_id")
      .eq("id", data.postId)
      .eq("product_id", product.id)
      .neq("moderation_status", "removed")
      .maybeSingle();
    if (postError) throw new Error(postError.message);
    if (!post) throw new Error("Post not found.");
    const { data: comment, error } = await (supabaseAdmin as any)
      .from("commerce_community_comments")
      .insert({
        post_id: post.id,
        product_id: product.id,
        creator_id: context.userId,
        access_grant_id: null,
        author_kind: "creator",
        author_name: identity.name,
        body: data.body,
      })
      .select(
        "id, post_id, author_kind, author_name, body, moderation_status, moderation_reason, created_at, updated_at",
      )
      .single();
    if (error || !comment) throw new Error(error?.message || "Comment could not be published.");
    if (post.access_grant_id) {
      const preview = data.body.replace(/\s+/g, " ").slice(0, 240);
      const { error: notificationError } = await (supabaseAdmin as any)
        .from("commerce_community_notifications")
        .insert({
          product_id: product.id,
          creator_id: context.userId,
          access_grant_id: post.access_grant_id,
          post_id: post.id,
          comment_id: comment.id,
          kind: "reply",
          title: `${identity.name} replied to your post`,
          body: preview,
        });
      if (notificationError) {
        // Publishing a reply must not be rolled back because a secondary
        // notification failed; the member will still see it in the thread.
        console.error("[community] creator reply notification deferred", notificationError);
      }
    }
    return comment;
  });

export const moderateCommunityContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        contentId: uuidSchema,
        kind: z.enum(["post", "comment"]),
        status: z.enum(["published", "hidden", "removed"]),
        reason: z.string().trim().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    await creatorCommunityProduct(context.userId, data.productId);
    const table = data.kind === "post" ? "commerce_community_posts" : "commerce_community_comments";
    const { data: updated, error } = await (supabaseAdmin as any)
      .from(table)
      .update({
        moderation_status: data.status,
        moderation_reason: data.status === "published" ? null : data.reason || "Creator moderation",
        moderated_at: data.status === "published" ? null : new Date().toISOString(),
        moderated_by: data.status === "published" ? null : context.userId,
      })
      .eq("id", data.contentId)
      .eq("product_id", data.productId)
      .eq("creator_id", context.userId)
      .select("id, moderation_status, moderation_reason")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error(`${data.kind === "post" ? "Post" : "Comment"} not found.`);
    return updated;
  });

export const saveCommunitySettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({
        productId: uuidSchema,
        welcomeMessage: z.string().trim().min(1).max(2_000),
        rules: z.string().trim().max(5_000),
        allowMemberPosts: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await requirePlanEntitlement(
      context.userId,
      "communities",
      "Community management is included with the Store plan.",
    );
    const product = await creatorCommunityProduct(context.userId, data.productId);
    const { data: updated, error } = await supabaseAdmin
      .from("commerce_products")
      .update({
        settings: {
          ...jsonObject((product as CommunityProductRow).settings),
          welcomeMessage: data.welcomeMessage,
          rules: data.rules,
          allowMemberPosts: data.allowMemberPosts,
        },
      })
      .eq("id", product.id)
      .eq("creator_id", context.userId)
      .select("*")
      .single();
    if (error || !updated) throw new Error(error?.message || "Settings could not be saved.");
    return updated;
  });

export const deleteCreatorCommunity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ productId: uuidSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const product = await creatorCommunityProduct(context.userId, data.productId);
    const db = context.supabase as any;
    const { data: result, error: deleteError } = await db.rpc("delete_unused_commerce_product", {
      p_product_id: product.id,
    });
    if (deleteError) throw new Error(deleteError.message || "Community could not be deleted.");
    if (!result || typeof result !== "object") {
      throw new Error("Community deletion did not return a result.");
    }
    return {
      deleted: result.deleted === true,
      archived: result.archived === true,
      removedBlocks: Math.max(0, Number(result.removedBlocks || 0)),
    };
  });
