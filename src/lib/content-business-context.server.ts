/* eslint-disable @typescript-eslint/no-explicit-any -- Aggregate creator-owned commerce rows. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export function summarizeBusinessOrders(
  orders: Array<{
    product_id: string;
    currency: string;
    gross_amount: number;
    refunded_amount: number;
  }>,
) {
  const groups = new Map<
    string,
    {
      productId: string;
      currency: string;
      orders: number;
      grossAmount: number;
      refundedAmount: number;
      revenueAfterRefunds: number;
    }
  >();
  for (const order of orders) {
    const key = `${order.product_id}:${order.currency}`;
    const row = groups.get(key) || {
      productId: order.product_id,
      currency: order.currency,
      orders: 0,
      grossAmount: 0,
      refundedAmount: 0,
      revenueAfterRefunds: 0,
    };
    row.orders += 1;
    row.grossAmount += Number(order.gross_amount) || 0;
    row.refundedAmount += Number(order.refunded_amount) || 0;
    row.revenueAfterRefunds = row.grossAmount - row.refundedAmount;
    groups.set(key, row);
  }
  return [...groups.values()];
}

export async function loadContentBusinessContext(userId: string, db = supabaseAdmin as any) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [products, orders] = await Promise.all([
    db
      .from("commerce_products")
      .select("id,title,kind,status,subtitle,price_amount,currency,pricing_type,sales_count")
      .eq("creator_id", userId)
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("commerce_orders")
      .select("product_id,currency,gross_amount,refunded_amount", { count: "exact" })
      .eq("creator_id", userId)
      .in("status", ["paid", "partially_refunded", "refunded"])
      .gte("paid_at", since)
      .order("paid_at", { ascending: false })
      .limit(1000),
  ]);
  // Missing commerce data should not prevent a creator from using the writing agent.
  return {
    periodStart: since,
    periodEnd: new Date().toISOString(),
    amountUnit:
      "minor currency units; currencies must be kept separate; revenue is gross less refunds, before fees and taxes",
    products: products.error ? [] : products.data || [],
    salesByProduct: orders.error ? [] : summarizeBusinessOrders(orders.data || []),
    salesSampleLimited: (orders.count || 0) > 1000,
    unavailable: [...(products.error ? ["products"] : []), ...(orders.error ? ["sales"] : [])],
    guidance:
      "Use sales and social evidence to suggest products, positioning, offers and small validation experiments. Mark recommendations as hypotheses; never claim conversion, profit, or attribution without data. Do not expose buyer identities.",
  };
}
