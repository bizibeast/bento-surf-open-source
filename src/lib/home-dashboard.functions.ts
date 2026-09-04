import "@tanstack/react-start";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type HomeDashboard = {
  pulse: {
    sales: { current: number; previous: number };
    impressions: { current: number; previous: number };
    posts: { current: number; previous: number };
    upcomingCalls: number;
  };
  attention: Array<{
    id: string;
    title: string;
    detail: string;
    to: "/post-scheduler" | "/calendar";
  }>;
  suggestion: {
    title: string;
    detail: string;
    to: "/social-insights" | "/post-scheduler" | "/store";
  } | null;
  insights: Array<{
    id: string;
    provider: string;
    caption: string | null;
    contentType: string;
    publishedAt: string;
    impressions: number | null;
    exposureLabel: "views" | "impressions";
    engagements: number | null;
  }>;
  posts: Array<{
    id: string;
    title: string | null;
    body: string;
    status: string;
    scheduledAt: string | null;
    publishedAt: string | null;
    createdAt: string;
    providers: string[];
  }>;
  calls: Array<{
    id: string;
    buyerName: string | null;
    buyerEmail: string;
    startsAt: string;
    meetingUrl: string | null;
  }>;
  sales: Array<{
    id: string;
    buyerName: string | null;
    buyerEmail: string;
    productTitle: string | null;
    status: string;
    grossAmount: number;
    refundedAmount: number;
    currency: string;
    occurredAt: string;
  }>;
};

export function homeDashboardFromRows(
  insightRows: any[],
  postRows: any[],
  callRows: any[],
  saleRows: any[],
  options: { now?: number; upcomingCalls?: number } = {},
): HomeDashboard {
  const now = options.now ?? Date.now();
  const weekAgo = now - 7 * 86_400_000;
  const fortnightAgo = now - 14 * 86_400_000;
  const inPeriod = (value: string, start: number, end: number) => {
    const time = new Date(value).getTime();
    return time >= start && time < end;
  };
  const metric = (rows: any[], date: (row: any) => string, value = (_row: any) => 1) => ({
    current: rows
      .filter((row) => inPeriod(date(row), weekAgo, now))
      .reduce((total, row) => total + value(row), 0),
    previous: rows
      .filter((row) => inPeriod(date(row), fortnightAgo, weekAgo))
      .reduce((total, row) => total + value(row), 0),
  });
  const insights = insightRows.map((row) => ({
    id: row.id,
    provider: row.provider,
    caption: row.caption,
    contentType: row.content_type,
    publishedAt: row.published_at,
    impressions:
      row.views == null
        ? row.impressions == null
          ? null
          : Number(row.impressions)
        : Number(row.views),
    exposureLabel: (row.views == null ? "impressions" : "views") as "views" | "impressions",
    engagements: row.engagements == null ? null : Number(row.engagements),
  }));
  const posts = postRows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    providers: (row.social_post_targets || []).map((target: any) => target.provider),
  }));
  const calls = callRows.map((row) => ({
    id: row.id,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    startsAt: row.starts_at,
    meetingUrl: row.meeting_url,
  }));
  const sales = saleRows.map((row) => ({
    id: row.id,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    productTitle: Array.isArray(row.commerce_products)
      ? row.commerce_products[0]?.title || null
      : row.commerce_products?.title || null,
    status: row.status,
    grossAmount: Number(row.gross_amount || 0),
    refundedAmount: Number(row.refunded_amount || 0),
    currency: row.currency,
    occurredAt: row.paid_at || row.created_at,
  }));
  const attention: HomeDashboard["attention"] = [];
  const nextCall = calls.find(
    (call) => new Date(call.startsAt).getTime() <= now + 24 * 60 * 60_000,
  );
  if (nextCall) {
    attention.push({
      id: `call:${nextCall.id}`,
      title: "Call coming up",
      detail: nextCall.buyerName || nextCall.buyerEmail,
      to: "/calendar",
    });
  }
  const failedPost = posts.find((post) => ["failed", "partially_failed"].includes(post.status));
  if (failedPost) {
    attention.push({
      id: `post:${failedPost.id}`,
      title: "Post needs attention",
      detail: failedPost.title || failedPost.body || "Open the scheduler to review it.",
      to: "/post-scheduler",
    });
  }
  const bestInsight = [...insights].sort(
    (left, right) => (right.engagements || 0) - (left.engagements || 0),
  )[0];
  const suggestion = bestInsight
    ? {
        title: "Repost what worked",
        detail: bestInsight.caption || `${bestInsight.provider} is leading your recent content.`,
        to: "/social-insights" as const,
      }
    : posts.length
      ? sales.length
        ? null
        : {
            title: "Put something on sale",
            detail: "Turn your audience into your first customer.",
            to: "/store" as const,
          }
      : {
          title: "Plan your next post",
          detail: "A small publishing rhythm beats an empty queue.",
          to: "/post-scheduler" as const,
        };

  return {
    pulse: {
      sales: metric(sales, (sale) => sale.occurredAt),
      impressions: metric(
        insights,
        (insight) => insight.publishedAt,
        (insight) => insight.impressions || 0,
      ),
      posts: metric(
        posts.filter((post) => post.status === "published"),
        (post) => post.publishedAt || post.scheduledAt || post.createdAt,
      ),
      upcomingCalls: options.upcomingCalls ?? calls.length,
    },
    attention,
    suggestion,
    insights: insights.slice(0, 4),
    posts: posts.slice(0, 4),
    calls: calls.slice(0, 4),
    sales: sales.slice(0, 4),
  };
}

export const getHomeDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<HomeDashboard> => {
    const db = supabaseAdmin as any;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const fortnightAgo = new Date(now - 14 * 86_400_000).toISOString();
    const [insightsResult, postsResult, callsResult, salesResult] = await Promise.all([
      db
        .from("social_content_insights")
        .select("id,provider,caption,content_type,published_at,views,impressions,engagements")
        .eq("user_id", context.userId)
        .gte("published_at", fortnightAgo)
        .order("published_at", { ascending: false })
        .limit(1_000),
      db
        .from("social_posts")
        .select(
          "id,title,body,status,scheduled_at,published_at,created_at,social_post_targets(provider)",
        )
        .eq("user_id", context.userId)
        .gte("created_at", fortnightAgo)
        .order("created_at", { ascending: false })
        .limit(500),
      db
        .from("commerce_bookings")
        .select("id,buyer_name,buyer_email,starts_at,meeting_url", { count: "exact" })
        .eq("creator_id", context.userId)
        .eq("status", "confirmed")
        .gte("starts_at", nowIso)
        .order("starts_at", { ascending: true })
        .limit(4),
      db
        .from("commerce_orders")
        .select(
          "id,buyer_name,buyer_email,status,gross_amount,refunded_amount,currency,paid_at,created_at,commerce_products(title)",
        )
        .eq("creator_id", context.userId)
        .in("status", ["paid", "partially_refunded", "refunded"])
        .gte("created_at", fortnightAgo)
        .order("created_at", { ascending: false })
        .limit(1_000),
    ]);

    const error =
      insightsResult.error || postsResult.error || callsResult.error || salesResult.error;
    if (error) throw new Error(`Home activity could not be loaded: ${error.message}`);

    return homeDashboardFromRows(
      insightsResult.data || [],
      postsResult.data || [],
      callsResult.data || [],
      salesResult.data || [],
      { now, upcomingCalls: callsResult.count ?? undefined },
    );
  });
