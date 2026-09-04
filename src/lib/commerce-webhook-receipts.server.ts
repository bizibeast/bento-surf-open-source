/* eslint-disable @typescript-eslint/no-explicit-any -- Commerce webhook rows are service-role only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type CommerceWebhookClaim = "claimed" | "processed" | "busy";

export async function claimCommerceWebhookEvent(input: {
  provider: string;
  eventId: string;
  eventType: string;
  payload: unknown;
}): Promise<CommerceWebhookClaim> {
  const { data, error } = await (supabaseAdmin as any).rpc("claim_commerce_webhook_event", {
    p_provider: input.provider,
    p_provider_event_id: input.eventId,
    p_event_type: input.eventType,
    p_payload: input.payload,
  });
  if (error) throw new Error(error.message);
  if (data !== "claimed" && data !== "processed" && data !== "busy") {
    throw new Error("Webhook receipt returned an invalid claim state.");
  }
  return data;
}

export async function completeCommerceWebhookEvent(provider: string, eventId: string) {
  const { data, error } = await (supabaseAdmin as any)
    .from("commerce_webhook_events")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("provider", provider)
    .eq("provider_event_id", eventId)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Webhook receipt is no longer owned by this worker.");
}

export async function failCommerceWebhookEvent(provider: string, eventId: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message.slice(0, 1_000) : "Unknown error";
  const { data, error } = await (supabaseAdmin as any)
    .from("commerce_webhook_events")
    .update({ status: "failed", error_message: message })
    .eq("provider", provider)
    .eq("provider_event_id", eventId)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}
