import { reserveXRead } from "./provider-budget.server";
import {
  xAccountCapabilities,
  xCapabilitiesFromMetadata,
  xCapabilitiesMetadata,
} from "./x-account";

export async function fetchXAccountCapabilities(
  token: string,
  connection?: { id: string; user_id: string; metadata?: Record<string, unknown> },
) {
  const cached = xCapabilitiesFromMetadata(connection?.metadata);
  const checkedAt = Date.parse(String(connection?.metadata?.x_capabilities_checked_at || ""));
  const age = Date.now() - checkedAt;
  if (cached && Number.isFinite(age) && age >= 0 && age < 7 * 86400000) return cached;
  await reserveXRead("https://api.x.com/2/users/me", connection?.user_id);
  const response = await fetch(
    "https://api.x.com/2/users/me?user.fields=subscription_type,verified_type",
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error("X account privileges could not be checked.");
  const payload = (await response.json()) as {
    data?: { subscription_type?: unknown; verified_type?: unknown };
  };
  if (!payload.data || typeof payload.data.subscription_type !== "string") {
    throw new Error("X did not return the account's subscription type.");
  }
  const capabilities = xAccountCapabilities(
    payload.data.subscription_type,
    payload.data.verified_type,
  );
  if (connection) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("social_connections")
      .update({
        metadata: { ...connection.metadata, ...xCapabilitiesMetadata(capabilities) },
      })
      .eq("id", connection.id)
      .eq("user_id", connection.user_id);
    if (error) throw new Error("X account privileges could not be cached.");
  }
  return capabilities;
}
