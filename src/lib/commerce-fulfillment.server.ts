/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce rows are service-role only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueCommerceOrderEmails } from "./email.server";
import { decryptServerSecret } from "./secret-crypto.server";
import type { CommerceBuyerAnswer } from "./commerce";
import { priorityDmFollowUpContext } from "./priority-dm";

type CommercePaymentSession = {
  id: string;
  provider: string;
  provider_checkout_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

type CommerceOrder = {
  id: string;
  provider: string;
  provider_checkout_id: string | null;
  product_id?: string;
  status?: string;
};

export function commerceFulfillmentMatchKey(provider: string, checkoutId: string) {
  return `${provider.trim().toLowerCase()}:${checkoutId.trim()}`;
}

export function commerceOrderEmailKeys(
  orderId: string,
  priorityDm?: { priorityDmMessageId: string | null; notificationEligible?: boolean },
) {
  return [
    `buyer-receipt:${orderId}`,
    ...(priorityDm
      ? priorityDm.priorityDmMessageId && priorityDm.notificationEligible !== false
        ? [`priority-dm-message:${priorityDm.priorityDmMessageId}:creator`]
        : []
      : [`creator-sale:${orderId}`]),
  ];
}

export function commerceBuyerAnswersFromSession(
  session: CommercePaymentSession | null | undefined,
): CommerceBuyerAnswer[] {
  if (!Array.isArray(session?.metadata?.buyer_answers)) return [];
  return session.metadata.buyer_answers
    .flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const answer = value as Record<string, unknown>;
      const question = typeof answer.question === "string" ? answer.question.trim() : "";
      const response = typeof answer.answer === "string" ? answer.answer.trim() : "";
      if (!question || !response) return [];
      const sanitized: CommerceBuyerAnswer = {
        question: question.slice(0, 500),
        answer: response.slice(0, 10_000),
      };
      const candidate = {
        ...sanitized,
        ...(typeof answer.priorityDmRequestId === "string"
          ? { priorityDmRequestId: answer.priorityDmRequestId }
          : {}),
      };
      return [priorityDmFollowUpContext([candidate]) ? candidate : sanitized];
    })
    .slice(0, 20);
}

export function commerceOrderMetadata(
  session: CommercePaymentSession | null | undefined,
  providerMetadata: Record<string, unknown> = {},
) {
  const buyerAnswers = commerceBuyerAnswersFromSession(session);
  const followUp = priorityDmFollowUpContext(buyerAnswers);
  const safeProviderMetadata = { ...providerMetadata };
  delete safeProviderMetadata.commerce_intent;
  delete safeProviderMetadata.priority_dm_request_id;
  delete safeProviderMetadata.buyer_answers;
  return {
    ...safeProviderMetadata,
    ...(buyerAnswers.length ? { buyer_answers: buyerAnswers } : {}),
    ...(followUp
      ? {
          commerce_intent: "priority_dm_followup",
          priority_dm_request_id: followUp.requestId,
        }
      : {}),
  };
}

async function accessTokenFromSession(session: CommercePaymentSession | null | undefined) {
  const ciphertext = session?.metadata?.access_token_ciphertext;
  if (typeof ciphertext !== "string" || !ciphertext) return null;
  try {
    return await decryptServerSecret(ciphertext);
  } catch (error) {
    // A receipt linking to the passwordless customer library is preferable to
    // losing the receipt because an old access token cannot be decrypted.
    console.error("[commerce] private access token could not be restored", error);
    return null;
  }
}

export async function finalizeCommerceFulfillment(input: {
  session: CommercePaymentSession;
  orderId: string;
  providerCheckoutId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const db = supabaseAdmin as any;
  const patch: Record<string, unknown> = { status: "paid" };
  if (input.providerCheckoutId) patch.provider_checkout_id = input.providerCheckoutId;
  if (input.metadata) {
    patch.metadata = { ...(input.session.metadata || {}), ...input.metadata };
  }
  const { data: updated, error: updateError } = await db
    .from("commerce_payment_sessions")
    .update(patch)
    .eq("id", input.session.id)
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updated) throw new Error("Bento payment session could not be finalized.");

  try {
    await enqueueCommerceOrderEmails({
      orderId: input.orderId,
      accessToken: await accessTokenFromSession(input.session),
    });
    return { notificationsQueued: true };
  } catch (error) {
    // The scheduled reconciler repairs a missing outbox entry. Payment
    // webhooks must not be rejected after the paid order is already durable.
    console.error("[email] commerce order notification was deferred", error);
    return { notificationsQueued: false };
  }
}

export async function reconcileCommerceFulfillment(limit = 100) {
  const db = supabaseAdmin as any;
  const boundedLimit = Math.min(250, Math.max(1, Math.floor(limit)));
  const { data: incompleteSessions, error: sessionError } = await db
    .from("commerce_payment_sessions")
    .select("id,provider,provider_checkout_id,metadata,status")
    .neq("status", "paid")
    .not("provider_checkout_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(boundedLimit);
  if (sessionError) throw new Error(sessionError.message);

  const checkoutIds = Array.from(
    new Set(
      (incompleteSessions || [])
        .map((session: CommercePaymentSession) => session.provider_checkout_id)
        .filter((value: unknown): value is string => typeof value === "string" && Boolean(value)),
    ),
  );
  let reconciledSessions = 0;
  if (checkoutIds.length) {
    const { data: matchedOrders, error: matchedOrderError } = await db
      .from("commerce_orders")
      .select("id,provider,provider_checkout_id,status")
      .in("provider_checkout_id", checkoutIds)
      .in("status", ["paid", "partially_refunded", "refunded", "disputed"]);
    if (matchedOrderError) throw new Error(matchedOrderError.message);
    const paidCheckoutKeys = new Set(
      (matchedOrders || [])
        .filter((order: CommerceOrder) => Boolean(order.provider_checkout_id))
        .map((order: CommerceOrder) =>
          commerceFulfillmentMatchKey(order.provider, order.provider_checkout_id!),
        ),
    );
    for (const session of incompleteSessions || []) {
      if (
        !session.provider_checkout_id ||
        !paidCheckoutKeys.has(
          commerceFulfillmentMatchKey(session.provider, session.provider_checkout_id),
        )
      ) {
        continue;
      }
      const { error } = await db
        .from("commerce_payment_sessions")
        .update({ status: "paid" })
        .eq("id", session.id)
        .neq("status", "paid");
      if (error) throw new Error(error.message);
      reconciledSessions += 1;
    }
  }

  const { data: recentOrders, error: orderError } = await db
    .from("commerce_orders")
    .select("id,provider,provider_checkout_id,product_id")
    .in("status", ["paid", "partially_refunded", "refunded", "disputed"])
    .order("created_at", { ascending: false })
    .limit(boundedLimit);
  if (orderError) throw new Error(orderError.message);
  if (!recentOrders?.length) return { reconciledSessions, repairedOrders: 0, failedOrders: 0 };

  const [{ data: products, error: productError }, { data: priorityMessages, error: messageError }] =
    await Promise.all([
      db
        .from("commerce_products")
        .select("id,kind")
        .in(
          "id",
          Array.from(new Set(recentOrders.map((order: CommerceOrder) => order.product_id))),
        ),
      db
        .from("commerce_priority_dm_messages")
        .select("id,order_id,notification_eligible")
        .in(
          "order_id",
          recentOrders.map((order: CommerceOrder) => order.id),
        ),
    ]);
  if (productError || messageError) throw new Error(productError?.message || messageError?.message);
  const priorityProductIds = new Set(
    (products || [])
      .filter((product: { kind: string }) => product.kind === "priority_dm")
      .map((product: { id: string }) => product.id),
  );
  const priorityMessageByOrderId = new Map<string, { id: string; notification_eligible: boolean }>(
    (priorityMessages || []).map(
      (message: { id: string; order_id: string; notification_eligible: boolean }) => [
        message.order_id,
        message,
      ],
    ),
  );
  const emailKeysForOrder = (order: CommerceOrder) => {
    const priorityDm = Boolean(order.product_id && priorityProductIds.has(order.product_id));
    const priorityMessage = priorityMessageByOrderId.get(order.id);
    return commerceOrderEmailKeys(
      order.id,
      priorityDm
        ? {
            priorityDmMessageId: priorityMessage?.id || null,
            notificationEligible: priorityMessage?.notification_eligible,
          }
        : undefined,
    );
  };
  const expectedKeys = recentOrders.flatMap(emailKeysForOrder);
  const { data: existingEmails, error: emailError } = await db
    .from("email_outbox")
    .select("event_key")
    .in("event_key", expectedKeys);
  if (emailError) throw new Error(emailError.message);
  const existingKeys = new Set(
    (existingEmails || []).map((row: { event_key: string }) => row.event_key),
  );
  const ordersNeedingRepair = recentOrders.filter((order: CommerceOrder) => {
    const missingPriorityMessage =
      Boolean(order.product_id && priorityProductIds.has(order.product_id)) &&
      !priorityMessageByOrderId.has(order.id);
    return missingPriorityMessage || emailKeysForOrder(order).some((key) => !existingKeys.has(key));
  });
  if (!ordersNeedingRepair.length) {
    return { reconciledSessions, repairedOrders: 0, failedOrders: 0 };
  }

  const repairCheckoutIds = Array.from(
    new Set(
      ordersNeedingRepair
        .map((order: CommerceOrder) => order.provider_checkout_id)
        .filter((value: unknown): value is string => typeof value === "string" && Boolean(value)),
    ),
  );
  const sessionsByCheckout = new Map<string, CommercePaymentSession>();
  if (repairCheckoutIds.length) {
    const { data: sessions, error } = await db
      .from("commerce_payment_sessions")
      .select("id,provider,provider_checkout_id,metadata")
      .in("provider_checkout_id", repairCheckoutIds);
    if (error) throw new Error(error.message);
    for (const session of sessions || []) {
      if (!session.provider_checkout_id) continue;
      sessionsByCheckout.set(
        commerceFulfillmentMatchKey(session.provider, session.provider_checkout_id),
        session,
      );
    }
  }

  let repairedOrders = 0;
  let failedOrders = 0;
  for (const order of ordersNeedingRepair) {
    const session = order.provider_checkout_id
      ? sessionsByCheckout.get(
          commerceFulfillmentMatchKey(order.provider, order.provider_checkout_id),
        )
      : null;
    try {
      await enqueueCommerceOrderEmails({
        orderId: order.id,
        accessToken: await accessTokenFromSession(session),
      });
      repairedOrders += 1;
    } catch (error) {
      failedOrders += 1;
      console.error(`[commerce] order notification repair failed for ${order.id}`, error);
    }
  }
  return { reconciledSessions, repairedOrders, failedOrders };
}
