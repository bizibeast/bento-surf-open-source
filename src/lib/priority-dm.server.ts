/* eslint-disable @typescript-eslint/no-explicit-any -- Priority DM tables await generated Supabase types. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { CommerceBuyerAnswer, CommerceProductSettings } from "./commerce";
import { priorityDmFollowUpContext, priorityDmPolicy } from "./priority-dm";

type PriorityDmStatus = "unread" | "read" | "replied" | "closed";

type PriorityDmRequestRow = {
  id: string;
  order_id: string;
  product_id: string;
  creator_id: string;
  buyer_email: string;
  buyer_name: string | null;
  status: PriorityDmStatus;
  free_follow_up_limit: number;
  follow_up_price_amount: number;
  follow_up_currency: string;
  last_message_at: string;
  last_message_preview: string;
};

type PriorityDmMessageRow = {
  id: string;
  request_id?: string;
  sender: "buyer" | "creator";
  body: string;
  order_id: string | null;
  created_at: string;
};

export type PriorityDmConversationView = {
  id: string;
  productId: string;
  productTitle: string;
  buyerName: string | null;
  buyerEmail?: string;
  creatorName: string;
  creatorUsername: string;
  status: PriorityDmStatus;
  freeFollowUpLimit: number;
  freeFollowUpsUsed: number;
  freeFollowUpsRemaining: number;
  followUpPriceAmount: number;
  currency: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  canReply: boolean;
  readOnlyReason: string | null;
  messages: Array<{
    id: string;
    sender: "buyer" | "creator";
    body: string;
    createdAt: string;
  }>;
};

export type PriorityDmConversationSummary = {
  id: string;
  productId: string;
  productTitle: string;
  buyerName: string | null;
  buyerEmail: string;
  status: PriorityDmStatus;
  lastMessageAt: string;
  lastMessagePreview: string;
};

export type PriorityDmMessageCursor = { createdAt: string; id: string };
export type PriorityDmConversationPage = {
  conversation: PriorityDmConversationView;
  nextCursor: PriorityDmMessageCursor | null;
};

export const PRIORITY_DM_MESSAGE_PAGE_SIZE = 100;

export async function loadPriorityDmInboxForCreator(client: any, creatorId: string) {
  const { data, error } = await client
    .from("commerce_priority_dm_requests")
    .select(
      "id, product_id, buyer_email, buyer_name, status, last_message_at, last_message_preview, product:commerce_products(title)",
    )
    .eq("creator_id", creatorId)
    .order("last_message_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);

  return (data || []).map((request: any): PriorityDmConversationSummary => ({
    id: request.id,
    productId: request.product_id,
    productTitle:
      (Array.isArray(request.product) ? request.product[0] : request.product)?.title ||
      "Priority DM",
    buyerName: request.buyer_name,
    buyerEmail: request.buyer_email,
    status: request.status,
    lastMessageAt: request.last_message_at,
    lastMessagePreview: request.last_message_preview,
  }));
}

export function mapPriorityDmConversationView(
  input: {
    request: Omit<PriorityDmRequestRow, "order_id" | "creator_id"> &
      Partial<Pick<PriorityDmRequestRow, "order_id" | "creator_id">>;
    product: { title: string };
    creator: { display_name: string | null; username: string };
    order: { status: string };
    messages: readonly PriorityDmMessageRow[];
  },
  includeBuyerEmail: boolean,
): PriorityDmConversationView {
  const freeFollowUpsUsed = input.messages.filter(
    (message) => message.sender === "buyer" && message.order_id === null,
  ).length;
  const orderCanReply = ["paid", "partially_refunded"].includes(input.order.status);
  const canReply = input.request.status !== "closed" && orderCanReply;
  return {
    id: input.request.id,
    productId: input.request.product_id,
    productTitle: input.product.title,
    buyerName: input.request.buyer_name,
    ...(includeBuyerEmail ? { buyerEmail: input.request.buyer_email } : {}),
    creatorName: input.creator.display_name || input.creator.username,
    creatorUsername: input.creator.username,
    status: input.request.status,
    freeFollowUpLimit: input.request.free_follow_up_limit,
    freeFollowUpsUsed,
    freeFollowUpsRemaining: Math.max(0, input.request.free_follow_up_limit - freeFollowUpsUsed),
    followUpPriceAmount: input.request.follow_up_price_amount,
    currency: input.request.follow_up_currency,
    lastMessageAt: input.request.last_message_at,
    lastMessagePreview: input.request.last_message_preview,
    canReply,
    readOnlyReason: canReply
      ? null
      : input.request.status === "closed"
        ? "This conversation is closed."
        : "This purchase is no longer eligible for replies.",
    messages: input.messages.map((message) => ({
      id: message.id,
      sender: message.sender,
      body: message.body,
      createdAt: message.created_at,
    })),
  };
}

export async function recordPriorityDmOrder(input: {
  order: {
    id: string;
    product_id: string;
    creator_id: string;
    buyer_email: string;
    buyer_name: string | null;
  };
  product: {
    id: string;
    kind: string;
    price_amount: number;
    currency: string;
    settings: CommerceProductSettings | null;
  };
  buyerAnswers: CommerceBuyerAnswer[];
}) {
  const db = supabaseAdmin as any;
  const followUp = priorityDmFollowUpContext(input.buyerAnswers);
  let requestId = followUp?.requestId;
  let body = followUp?.body;

  if (!requestId) {
    body = String(
      input.buyerAnswers.find((answer) => answer.question === "Priority message")?.answer || "",
    ).trim();
    if (!body) throw new Error("Priority message was not captured with paid order.");
    const policy = priorityDmPolicy(input.product.settings, input.product.price_amount);
    const { error } = await db.from("commerce_priority_dm_requests").upsert(
      {
        order_id: input.order.id,
        product_id: input.order.product_id,
        creator_id: input.order.creator_id,
        buyer_email: input.order.buyer_email.trim().toLowerCase(),
        buyer_name: input.order.buyer_name,
        message: body,
        free_follow_up_limit: policy.freeFollowUpLimit,
        follow_up_price_amount: policy.followUpPriceAmount,
        follow_up_currency: input.product.currency.trim().toLowerCase(),
      },
      { onConflict: "order_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
    const { data: request, error: requestError } = await db
      .from("commerce_priority_dm_requests")
      .select("id")
      .eq("order_id", input.order.id)
      .single();
    if (requestError || !request) {
      throw new Error(requestError?.message || "Priority conversation not found.");
    }
    requestId = request.id;
  }
  if (!requestId || !body) throw new Error("Priority message was not captured with paid order.");

  const { data: message, error: messageError } = await db.rpc("append_priority_dm_message", {
    p_request_id: requestId,
    p_sender: "buyer",
    p_body: body,
    p_order_id: input.order.id,
  });
  if (messageError || !message?.id) {
    throw new Error(messageError?.message || "Priority message could not be saved.");
  }
  return { requestId, messageId: String(message.id) };
}

export async function loadPriorityDmPaidFollowUp(input: {
  requestId: string;
  productId: string;
  buyerEmail: string;
}) {
  const db = supabaseAdmin as any;
  const { data: request, error } = await db
    .from("commerce_priority_dm_requests")
    .select(priorityDmRequestColumns)
    .eq("id", input.requestId)
    .eq("product_id", input.productId)
    .eq("buyer_email", input.buyerEmail.trim().toLowerCase())
    .neq("status", "closed")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!request) throw new Error("Priority conversation not found.");

  const [{ count, error: messageError }, { data: order, error: orderError }] = await Promise.all([
    db
      .from("commerce_priority_dm_messages")
      .select("id", { count: "exact", head: true })
      .eq("request_id", request.id)
      .eq("sender", "buyer")
      .is("order_id", null),
    db.from("commerce_orders").select("status").eq("id", request.order_id).maybeSingle(),
  ]);
  if (messageError || orderError) throw new Error(messageError?.message || orderError?.message);
  if (!order || !["paid", "partially_refunded"].includes(order.status)) {
    throw new Error("This purchase is no longer eligible for replies.");
  }

  return {
    id: request.id as string,
    freeFollowUpsRemaining: Math.max(0, request.free_follow_up_limit - Number(count || 0)),
    followUpPriceAmount: request.follow_up_price_amount as number,
    currency: request.follow_up_currency as string,
  };
}

export async function loadPriorityDmConversationPage(
  request: PriorityDmRequestRow,
  includeBuyerEmail: boolean,
  before?: PriorityDmMessageCursor,
): Promise<PriorityDmConversationPage> {
  const db = supabaseAdmin as any;
  let query = db
    .from("commerce_priority_dm_messages")
    .select("id, request_id, sender, body, order_id, created_at")
    .eq("request_id", request.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PRIORITY_DM_MESSAGE_PAGE_SIZE + 1);
  if (before) {
    query = query.or(
      `created_at.lt.${before.createdAt},and(created_at.eq.${before.createdAt},id.lt.${before.id})`,
    );
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data || []) as PriorityDmMessageRow[];
  const pageRows = rows.slice(0, PRIORITY_DM_MESSAGE_PAGE_SIZE);
  const oldest = pageRows.at(-1);
  const [conversation] = await loadPriorityDmConversationViews(
    [request],
    includeBuyerEmail,
    pageRows.reverse(),
  );
  return {
    conversation,
    nextCursor:
      rows.length > PRIORITY_DM_MESSAGE_PAGE_SIZE && oldest
        ? { createdAt: oldest.created_at, id: oldest.id }
        : null,
  };
}

export async function loadPriorityDmConversationViews(
  requests: PriorityDmRequestRow[],
  includeBuyerEmail: boolean,
  providedMessages?: PriorityDmMessageRow[],
) {
  if (!requests.length) return [];
  const db = supabaseAdmin as any;
  const [
    { data: messages, error: messageError },
    { data: products, error: productError },
    { data: creators, error: creatorError },
    { data: orders, error: orderError },
  ] = await Promise.all([
    providedMessages
      ? Promise.resolve({ data: providedMessages, error: null })
      : db
          .from("commerce_priority_dm_messages")
          .select("id, request_id, sender, body, order_id, created_at")
          .in(
            "request_id",
            requests.map((request) => request.id),
          )
          .order("created_at", { ascending: true }),
    db
      .from("commerce_products")
      .select("id, title")
      .in(
        "id",
        requests.map((request) => request.product_id),
      ),
    db
      .from("profiles")
      .select("id, username, display_name")
      .in(
        "id",
        requests.map((request) => request.creator_id),
      ),
    db
      .from("commerce_orders")
      .select("id, status")
      .in(
        "id",
        requests.map((request) => request.order_id),
      ),
  ]);
  for (const error of [messageError, productError, creatorError, orderError]) {
    if (error) throw new Error(error.message);
  }
  const productsById = new Map<string, { title: string }>(
    (products || []).map((row: any) => [row.id, row]),
  );
  const creatorsById = new Map<string, { display_name: string | null; username: string }>(
    (creators || []).map((row: any) => [row.id, row]),
  );
  const ordersById = new Map<string, { status: string }>(
    (orders || []).map((row: any) => [row.id, row]),
  );
  return requests.map((request) =>
    mapPriorityDmConversationView(
      {
        request,
        product: productsById.get(request.product_id) || { title: "Priority DM" },
        creator: creatorsById.get(request.creator_id) || {
          display_name: null,
          username: "creator",
        },
        order: ordersById.get(request.order_id) || { status: "refunded" },
        messages: (messages || []).filter((message: any) => message.request_id === request.id),
      },
      includeBuyerEmail,
    ),
  );
}

export const priorityDmRequestColumns =
  "id, order_id, product_id, creator_id, buyer_email, buyer_name, status, free_follow_up_limit, follow_up_price_amount, follow_up_currency, last_message_at, last_message_preview";
