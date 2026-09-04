/* eslint-disable @typescript-eslint/no-explicit-any -- Priority DM tables await generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { currentCustomerSession } from "./customer-library-auth.server";
import {
  enqueuePriorityDmMessageToBuyerEmail,
  enqueuePriorityDmMessageToCreatorEmail,
} from "./email.server";
import {
  loadPriorityDmConversationPage,
  loadPriorityDmConversationViews,
  loadPriorityDmInboxForCreator,
  priorityDmRequestColumns,
} from "./priority-dm.server";

const uuid = z.string().uuid();
const body = z.string().trim().min(1).max(10_000);
const messageCursor = z.object({ createdAt: z.string().datetime({ offset: true }), id: uuid });

export async function appendPriorityDmMessageAndNotify(
  input: {
    requestId: string;
    sender: "buyer" | "creator";
    body: string;
    orderId: string | null;
  },
  enqueue: (input: { requestId: string; messageId: string }) => Promise<unknown>,
) {
  const { data: message, error } = await (supabaseAdmin as any).rpc("append_priority_dm_message", {
    p_request_id: input.requestId,
    p_sender: input.sender,
    p_body: input.body,
    p_order_id: input.orderId,
  });
  if (error || !message?.id) throw new Error(error?.message || "Priority message was not saved.");
  try {
    await enqueue({ requestId: input.requestId, messageId: message.id });
  } catch (notificationError) {
    console.error(
      `[email] Priority DM ${input.sender} notification was deferred`,
      notificationError,
    );
  }
  return message as { id: string };
}

export async function markCreatorPriorityDmReadIfCurrent(
  client: any,
  input: { requestId: string; creatorId: string; lastMessageAt: string },
) {
  const { error } = await client
    .from("commerce_priority_dm_requests")
    .update({ creator_last_read_at: new Date().toISOString(), status: "read" })
    .eq("id", input.requestId)
    .eq("creator_id", input.creatorId)
    .eq("status", "unread")
    .eq("last_message_at", input.lastMessageAt);
  if (error) throw new Error(error.message);
}

async function creatorRequest(client: any, requestId: string, creatorId: string) {
  const { data, error } = await client
    .from("commerce_priority_dm_requests")
    .select(priorityDmRequestColumns)
    .eq("id", requestId)
    .eq("creator_id", creatorId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Priority conversation not found.");
  return data;
}

async function buyerRequest(requestId: string, email: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("commerce_priority_dm_requests")
    .select(priorityDmRequestColumns)
    .eq("id", requestId)
    .eq("buyer_email", email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Priority conversation not found.");
  return data;
}

async function assertCanReply(request: any) {
  if (request.status === "closed") throw new Error("This conversation is closed.");
  const { data: order, error } = await (supabaseAdmin as any)
    .from("commerce_orders")
    .select("status")
    .eq("id", request.order_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order || !["paid", "partially_refunded"].includes(order.status)) {
    throw new Error("This purchase is no longer eligible for replies.");
  }
}

async function currentBuyer() {
  const identity = await currentCustomerSession();
  if (!identity) throw new Error("Sign in to your customer library to continue.");
  return identity.customer.email_normalized;
}

export const getMyPriorityDmInbox = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => loadPriorityDmInboxForCreator(context.supabase, context.userId));

export const getMyPriorityDmConversationPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z.object({ requestId: uuid, before: messageCursor.optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const request = await creatorRequest(context.supabase, data.requestId, context.userId);
    return loadPriorityDmConversationPage(request, true, data.before);
  });

export const sendCreatorPriorityDmMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ requestId: uuid, body }).parse(input))
  .handler(async ({ data, context }) => {
    const request = await creatorRequest(context.supabase, data.requestId, context.userId);
    await assertCanReply(request);
    return appendPriorityDmMessageAndNotify(
      {
        requestId: request.id,
        sender: "creator",
        body: data.body,
        orderId: null,
      },
      enqueuePriorityDmMessageToBuyerEmail,
    );
  });

export const setPriorityDmConversationClosed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) => z.object({ requestId: uuid, closed: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const request = await creatorRequest(context.supabase, data.requestId, context.userId);
    const { error } = await (supabaseAdmin as any)
      .from("commerce_priority_dm_requests")
      .update({ status: data.closed ? "closed" : "read" })
      .eq("id", request.id)
      .eq("creator_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markCreatorPriorityDmRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input) =>
    z
      .object({ requestId: uuid, lastMessageAt: z.string().datetime({ offset: true }) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const request = await creatorRequest(context.supabase, data.requestId, context.userId);
    await markCreatorPriorityDmReadIfCurrent(supabaseAdmin as any, {
      requestId: request.id,
      creatorId: context.userId,
      lastMessageAt: data.lastMessageAt,
    });
    return { ok: true };
  });

export const getCustomerPriorityDm = createServerFn({ method: "GET" })
  .validator((input) => z.object({ requestId: uuid }).parse(input))
  .handler(async ({ data }) => {
    const request = await buyerRequest(data.requestId, await currentBuyer());
    return (await loadPriorityDmConversationViews([request], false))[0];
  });

export const sendCustomerPriorityDmMessage = createServerFn({ method: "POST" })
  .validator((input) => z.object({ requestId: uuid, body }).parse(input))
  .handler(async ({ data }) => {
    const email = await currentBuyer();
    const request = await buyerRequest(data.requestId, email);
    await assertCanReply(request);
    return appendPriorityDmMessageAndNotify(
      {
        requestId: request.id,
        sender: "buyer",
        body: data.body,
        orderId: null,
      },
      enqueuePriorityDmMessageToCreatorEmail,
    );
  });

export const markCustomerPriorityDmRead = createServerFn({ method: "POST" })
  .validator((input) => z.object({ requestId: uuid }).parse(input))
  .handler(async ({ data }) => {
    const email = await currentBuyer();
    const request = await buyerRequest(data.requestId, email);
    const { error } = await (supabaseAdmin as any)
      .from("commerce_priority_dm_requests")
      .update({ buyer_last_read_at: new Date().toISOString() })
      .eq("id", request.id)
      .eq("buyer_email", email);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
