/* eslint-disable @typescript-eslint/no-explicit-any -- Safety tables are typed after migration. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Provider = "instagram" | "facebook";

export function metaDmPreferenceCommand(text: string | null | undefined) {
  const value = (text || "").normalize("NFKC").trim().toLocaleLowerCase();
  if (["stop", "unsubscribe", "cancel"].includes(value)) return "stop";
  if (value === "start") return "start";
  return null;
}

export async function handleMetaDmRecipientPreference(
  provider: Provider,
  providerUserId: string,
  senderHash: string | null,
  eventType: "comment" | "message",
  text: string | null | undefined,
  externalEventId: string,
  occurredAt: string | null,
): Promise<"command" | "opted_out" | null> {
  const command = eventType === "message" ? metaDmPreferenceCommand(text) : null;
  if (command && !senderHash) {
    throw new Error("Unable to identify the Meta recipient requesting a preference change.");
  }
  if (!senderHash) return null;
  if (command) {
    const { error } = await (supabaseAdmin as any).rpc("apply_meta_dm_recipient_command", {
      p_provider: provider,
      p_provider_user_id: providerUserId,
      p_sender_id_hash: senderHash,
      p_external_event_id: externalEventId,
      p_occurred_at: occurredAt,
      p_opted_out: command === "stop",
    });
    if (error) throw new Error("Unable to update Meta DM recipient preference.");
    return "command";
  }
  const { data, error } = await (supabaseAdmin as any)
    .from("meta_dm_recipient_preferences")
    .select("opted_out_at")
    .eq("provider", provider)
    .eq("provider_user_id", providerUserId)
    .eq("sender_id_hash", senderHash)
    .maybeSingle();
  if (error) throw new Error("Unable to check Meta DM recipient preference.");
  return data?.opted_out_at ? "opted_out" : null;
}

export async function claimMetaDmSend(input: {
  provider: Provider;
  providerUserId: string;
  senderHash: string | null;
  eventId: string;
  automationId: string;
  eventType: "comment" | "message";
  outboundCount?: 1 | 2;
}) {
  const { data, error } = await (supabaseAdmin as any).rpc("claim_meta_dm_send", {
    p_provider: input.provider,
    p_provider_user_id: input.providerUserId,
    p_sender_id_hash: input.senderHash,
    p_event_id: input.eventId,
    p_automation_id: input.automationId,
    p_event_type: input.eventType,
    p_outbound_count: input.outboundCount || 1,
  });
  if (error || typeof data !== "string") throw new Error("Unable to reserve a Meta DM send.");
  return data;
}

export async function noteMetaDmProviderRejection(
  provider: Provider,
  providerUserId: string,
  code: string,
) {
  const { error } = await (supabaseAdmin as any).rpc("note_meta_dm_provider_rejection", {
    p_provider: provider,
    p_provider_user_id: providerUserId,
    p_code: code,
  });
  if (error) throw new Error("Unable to record the Meta messaging rejection.");
}
