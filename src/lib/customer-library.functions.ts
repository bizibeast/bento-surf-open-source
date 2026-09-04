import { configuredAppOrigin } from "@/lib/application-urls";
/* eslint-disable @typescript-eslint/no-explicit-any -- Customer library tables are intentionally service-role only. */
import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  commerceTokenHash,
  plausibleCommerceToken,
  randomCommerceToken,
} from "./commerce-access.server";
import {
  currentCustomerSession,
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_DAYS,
} from "./customer-library-auth.server";
import { issueCustomerLibraryMagicLinkForEmail } from "./customer-library-magic-link.server";
import { enqueueEmail, normalizeEmailRecipient } from "./email.server";
import { enforceRequestRateLimit } from "./request-security.server";
import { sanitizeCustomerLibraryReturnTo } from "./safe-url";

const MAGIC_LINK_MINUTES = 15;
const LIBRARY_ACCESS_MINUTES = 15;

const emailSchema = z.string().trim().email().max(254);
const tokenSchema = z
  .string()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const uuidSchema = z.string().uuid();

function appUrl() {
  return configuredAppOrigin(process.env.VITE_APP_URL);
}

function setCustomerSessionCookie(token: string) {
  setCookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: CUSTOMER_SESSION_DAYS * 24 * 60 * 60,
  });
}

function clearCustomerSessionCookie() {
  deleteCookie(CUSTOMER_SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
}

export const requestCustomerLibraryLink = createServerFn({ method: "POST" })
  .validator((input) =>
    z.object({ email: emailSchema, returnTo: z.unknown().optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("AUTH_EMAIL_RATE_LIMITER", "customer-library-login");
    const email = normalizeEmailRecipient(data.email);
    if (!email) return { ok: true };
    await enforceRequestRateLimit(
      "AUTH_EMAIL_RATE_LIMITER",
      "customer-library-login-email",
      await commerceTokenHash(email),
    );
    const db = supabaseAdmin as any;
    const { data: customer, error } = await db
      .from("commerce_customers")
      .select("id, email, name")
      .eq("email_normalized", email)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // Always return the same response so this endpoint cannot enumerate buyers.
    if (!customer) return { ok: true };

    const verifyUrl = await issueCustomerLibraryMagicLinkForEmail({
      email,
      returnTo: sanitizeCustomerLibraryReturnTo(data.returnTo),
    });
    if (!verifyUrl) return { ok: true };
    await enqueueEmail({
      eventKey: `customer-library-login:${await commerceTokenHash(verifyUrl)}`,
      eventType: "customer_library_login",
      recipientEmail: customer.email,
      recipientName: customer.name,
      payload: { accessUrl: verifyUrl, expiresInMinutes: MAGIC_LINK_MINUTES },
      immediate: true,
    });
    return { ok: true };
  });

export const consumeCustomerLibraryLink = createServerFn({ method: "POST" })
  .validator((input) => z.object({ token: tokenSchema }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "customer-library-verify");
    const db = supabaseAdmin as any;
    const sessionToken = randomCommerceToken();
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_DAYS * 86_400_000).toISOString();
    const { data: consumed, error } = await db.rpc("consume_commerce_customer_magic_link", {
      p_token_hash: await commerceTokenHash(data.token),
      p_session_token_hash: await commerceTokenHash(sessionToken),
      p_session_expires_at: expiresAt,
    });
    if (error) throw new Error(error.message);
    if (!consumed?.[0]?.customer_id) return { ok: false };
    setCustomerSessionCookie(sessionToken);
    return { ok: true };
  });

export const getCustomerLibrary = createServerFn({ method: "GET" }).handler(async () => {
  const identity = await currentCustomerSession();
  if (!identity) return null;
  const db = supabaseAdmin as any;
  const { customer } = identity;
  const { data: grants, error } = await db
    .from("commerce_access_grants")
    .select("id, order_id, product_id, creator_id, status, expires_at, created_at")
    .eq("buyer_email", customer.email_normalized)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  const productIds = [...new Set((grants || []).map((row: any) => row.product_id))];
  const creatorIds = [...new Set((grants || []).map((row: any) => row.creator_id))];
  const orderIds = [...new Set((grants || []).map((row: any) => row.order_id))];
  const [productResult, creatorResult, orderResult] = await Promise.all([
    productIds.length
      ? db
          .from("commerce_products")
          .select("id, title, subtitle, kind, cover_url, currency")
          .in("id", productIds)
      : Promise.resolve({ data: [] }),
    creatorIds.length
      ? db.from("profiles").select("id, username, display_name, avatar_url").in("id", creatorIds)
      : Promise.resolve({ data: [] }),
    orderIds.length
      ? db
          .from("commerce_orders")
          .select(
            "id, gross_amount, net_amount, tax_amount, refunded_amount, currency, status, paid_at, created_at",
          )
          .in("id", orderIds)
      : Promise.resolve({ data: [] }),
  ]);
  if (productResult.error) throw new Error(productResult.error.message);
  if (creatorResult.error) throw new Error(creatorResult.error.message);
  if (orderResult.error) throw new Error(orderResult.error.message);
  const products = productResult.data;
  const creators = creatorResult.data;
  const orders = orderResult.data;
  const byProduct = new Map((products || []).map((row: any) => [row.id, row]));
  const byCreator = new Map((creators || []).map((row: any) => [row.id, row]));
  const byOrder = new Map((orders || []).map((row: any) => [row.id, row]));
  return {
    customer: { email: customer.email, name: customer.name },
    entries: (grants || []).map((grant: any) => ({
      grant,
      product: byProduct.get(grant.product_id) || null,
      creator: byCreator.get(grant.creator_id) || null,
      order: byOrder.get(grant.order_id) || null,
      canOpen:
        grant.status === "active" &&
        (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now()),
    })),
  };
});

export const getCustomerReceipt = createServerFn({ method: "GET" })
  .validator((input) => z.object({ orderId: uuidSchema }).parse(input))
  .handler(async ({ data }) => {
    const identity = await currentCustomerSession();
    if (!identity) return null;
    const db = supabaseAdmin as any;
    const { data: order, error } = await db
      .from("commerce_orders")
      .select(
        "id, product_id, creator_id, buyer_email, buyer_name, status, gross_amount, tax_amount, platform_fee_amount, refunded_amount, currency, provider, dispute_status, disputed_amount, dispute_reason, dispute_opened_at, dispute_resolved_at, paid_at, created_at",
      )
      .eq("id", data.orderId)
      .eq("buyer_email", identity.customer.email_normalized)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return null;
    const [{ data: product, error: productError }, { data: creator, error: creatorError }] =
      await Promise.all([
        db
          .from("commerce_products")
          .select("id, title, kind")
          .eq("id", order.product_id)
          .maybeSingle(),
        db
          .from("profiles")
          .select("username, display_name")
          .eq("id", order.creator_id)
          .maybeSingle(),
      ]);
    if (productError) throw new Error(productError.message);
    if (creatorError) throw new Error(creatorError.message);
    return {
      order: {
        id: order.id,
        buyerEmail: order.buyer_email,
        buyerName: order.buyer_name,
        status: order.status,
        grossAmount: Number(order.gross_amount || 0),
        taxAmount: Number(order.tax_amount || 0),
        platformFeeAmount: Number(order.platform_fee_amount || 0),
        refundedAmount: Number(order.refunded_amount || 0),
        currency: order.currency,
        provider: order.provider,
        disputeStatus: order.dispute_status,
        disputedAmount: Number(order.disputed_amount || 0),
        disputeReason: order.dispute_reason,
        disputeOpenedAt: order.dispute_opened_at,
        disputeResolvedAt: order.dispute_resolved_at,
        paidAt: order.paid_at,
        createdAt: order.created_at,
      },
      product: product
        ? { id: product.id, title: product.title, kind: product.kind }
        : { id: order.product_id, title: "Bento purchase", kind: "custom_product" },
      creator: {
        username: creator?.username || null,
        name: creator?.display_name || creator?.username || "Bento creator",
      },
    };
  });

export const createCustomerLibraryAccess = createServerFn({ method: "POST" })
  .validator((input) => z.object({ grantId: uuidSchema }).parse(input))
  .handler(async ({ data }) => {
    const identity = await currentCustomerSession();
    if (!identity) throw new Error("Sign in to your customer library again.");
    await enforceRequestRateLimit(
      "PUBLIC_API_RATE_LIMITER",
      "customer-library-access",
      identity.customer.id,
    );
    const db = supabaseAdmin as any;
    const { data: grant, error } = await db
      .from("commerce_access_grants")
      .select("id, buyer_email, status, expires_at")
      .eq("id", data.grantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (
      !grant ||
      String(grant.buyer_email || "")
        .trim()
        .toLowerCase() !== identity.customer.email_normalized ||
      grant.status !== "active" ||
      (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now())
    ) {
      throw new Error("This purchase is not currently accessible.");
    }
    const rawToken = randomCommerceToken();
    const expiresAt = new Date(Date.now() + LIBRARY_ACCESS_MINUTES * 60_000).toISOString();
    const { error: insertError } = await db.from("commerce_customer_access_tokens").insert({
      customer_id: identity.customer.id,
      grant_id: grant.id,
      token_hash: await commerceTokenHash(rawToken),
      expires_at: expiresAt,
    });
    if (insertError) throw new Error(insertError.message);
    return { url: `${appUrl()}/access/${encodeURIComponent(rawToken)}` };
  });

export const logoutCustomerLibrary = createServerFn({ method: "POST" }).handler(async () => {
  const token = getCookie(CUSTOMER_SESSION_COOKIE);
  if (plausibleCommerceToken(token)) {
    await (supabaseAdmin as any)
      .from("commerce_customer_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", await commerceTokenHash(token!));
  }
  clearCustomerSessionCookie();
  return { ok: true };
});
