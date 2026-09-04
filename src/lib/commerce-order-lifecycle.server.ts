/* eslint-disable @typescript-eslint/no-explicit-any -- The lifecycle RPC is added by an additive migration and is called with the service-role client. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueCommerceRefundEmails } from "./email.server";

export type CommerceRefundInput = {
  provider: string;
  providerPaymentId: string;
  providerAccountId?: string | null;
  providerEventId: string;
  refundAmount?: number | null;
  amountIsCumulative?: boolean;
  metadata?: Record<string, unknown>;
  occurredAt?: string | null;
};

export type CommerceRefundResult = {
  orderId: string;
  alreadyProcessed: boolean;
  refundedAmount: number;
  appliedAmount: number;
  fullyRefunded: boolean;
  status: "paid" | "partially_refunded" | "refunded";
};

export type CommerceDisputeOutcome =
  "open" | "under_review" | "won" | "lost" | "canceled" | "accepted" | "expired";

export type CommerceDisputeInput = {
  provider: string;
  providerPaymentId: string;
  providerAccountId?: string | null;
  providerEventId: string;
  disputeId: string;
  outcome: CommerceDisputeOutcome;
  disputedAmount?: number | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: string | null;
};

export type CommerceDisputeResult = {
  orderId: string;
  alreadyProcessed: boolean;
  stateApplied: boolean;
  disputeStatus: CommerceDisputeOutcome;
  status: string;
  suspendedGrants: number;
  restoredGrants: number;
};

function normalizeResult(value: any): CommerceRefundResult | null {
  if (!value?.order_id) return null;
  return {
    orderId: String(value.order_id),
    alreadyProcessed: Boolean(value.already_processed),
    refundedAmount: Math.max(0, Number(value.refunded_amount || 0)),
    appliedAmount: Math.max(0, Number(value.applied_amount || 0)),
    fullyRefunded: Boolean(value.fully_refunded),
    status: String(value.status) as CommerceRefundResult["status"],
  };
}

/**
 * Applies a signature-verified provider refund exactly once.
 *
 * The database locks the order, computes the cumulative refund, updates access,
 * and records the provider event in one transaction. Email delivery remains
 * asynchronous and idempotent, so a mail-provider outage cannot roll back a
 * valid refund.
 */
export async function applyCommerceRefund(
  input: CommerceRefundInput,
): Promise<CommerceRefundResult | null> {
  const { data, error } = await (supabaseAdmin as any).rpc("apply_commerce_refund", {
    p_provider: input.provider,
    p_provider_payment_id: input.providerPaymentId,
    p_provider_account_id: input.providerAccountId || null,
    p_provider_event_id: input.providerEventId,
    p_refund_amount:
      input.refundAmount == null ? null : Math.max(0, Math.round(input.refundAmount)),
    p_amount_is_cumulative: input.amountIsCumulative !== false,
    p_metadata: input.metadata || {},
    p_occurred_at: input.occurredAt || new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  const result = normalizeResult(data);
  if (!result || result.alreadyProcessed || result.appliedAmount <= 0) return result;

  try {
    await enqueueCommerceRefundEmails({
      orderId: result.orderId,
      eventKey: `${input.provider}:${input.providerEventId}`,
      amount: result.appliedAmount,
    });
  } catch (emailError) {
    console.error("[email] Commerce refund notification was deferred", emailError);
  }
  return result;
}

/**
 * Applies a signature-verified provider dispute exactly once.
 *
 * Access is suspended atomically while a dispute is open. A favorable
 * resolution restores only grants suspended by that dispute; an adverse
 * resolution keeps them revoked.
 */
export async function applyCommerceDispute(
  input: CommerceDisputeInput,
): Promise<CommerceDisputeResult | null> {
  const { data, error } = await (supabaseAdmin as any).rpc("apply_commerce_dispute_guarded", {
    p_provider: input.provider,
    p_provider_payment_id: input.providerPaymentId,
    p_provider_account_id: input.providerAccountId || null,
    p_provider_event_id: input.providerEventId,
    p_dispute_id: input.disputeId,
    p_outcome: input.outcome,
    p_disputed_amount:
      input.disputedAmount == null ? null : Math.max(0, Math.round(input.disputedAmount)),
    p_reason: input.reason || null,
    p_metadata: input.metadata || {},
    p_occurred_at: input.occurredAt || new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  if (!data?.order_id) return null;
  return {
    orderId: String(data.order_id),
    alreadyProcessed: Boolean(data.already_processed),
    stateApplied: Boolean(data.state_applied),
    disputeStatus: String(data.dispute_status) as CommerceDisputeOutcome,
    status: String(data.status),
    suspendedGrants: Math.max(0, Number(data.suspended_grants || 0)),
    restoredGrants: Math.max(0, Number(data.restored_grants || 0)),
  };
}
