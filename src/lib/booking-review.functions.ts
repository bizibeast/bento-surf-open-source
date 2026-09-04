/* eslint-disable @typescript-eslint/no-explicit-any -- Booking review tables ship through the matching migration. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enforceRequestRateLimit } from "./request-security.server";

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Review URLs are public and may be revisited after expiry. Accept a bounded,
// URL-safe token here and let the hash lookup return `null` so stale or malformed
// links render the friendly expired state instead of TanStack's error boundary.
const tokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,200}$/);

export const getBookingReview = createServerFn({ method: "GET" })
  .validator((input) => z.object({ token: tokenSchema }).parse(input))
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "booking-review-read");
    const db = supabaseAdmin as any;
    const { data: review, error } = await db
      .from("booking_reviews")
      .select("id,booking_id,reviewer_name,rating,body,submitted_at,commerce_bookings(product_id)")
      .eq("token_hash", await tokenHash(data.token))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!review) return null;
    const relatedBooking = Array.isArray(review.commerce_bookings)
      ? review.commerce_bookings[0]
      : review.commerce_bookings;
    const productId = relatedBooking?.product_id;
    const { data: product } = productId
      ? await db.from("commerce_products").select("title").eq("id", productId).maybeSingle()
      : { data: null };
    return {
      reviewerName: review.reviewer_name,
      rating: review.rating,
      body: review.body,
      submittedAt: review.submitted_at,
      productTitle: product?.title || "your session",
    };
  });

export const submitBookingReview = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        token: tokenSchema,
        rating: z.number().int().min(1).max(5),
        body: z.string().trim().max(5_000).default(""),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("PUBLIC_API_RATE_LIMITER", "booking-review-submit");
    const db = supabaseAdmin as any;
    const { data: existing, error } = await db
      .from("booking_reviews")
      .select("id,submitted_at")
      .eq("token_hash", await tokenHash(data.token))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!existing) throw new Error("This review link is not valid.");
    if (existing.submitted_at) throw new Error("This review was already submitted.");
    const { error: updateError } = await db
      .from("booking_reviews")
      .update({
        rating: data.rating,
        body: data.body || null,
        submitted_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .is("submitted_at", null);
    if (updateError) throw new Error(updateError.message);
    return { ok: true };
  });
