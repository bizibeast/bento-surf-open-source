/* eslint-disable @typescript-eslint/no-explicit-any -- Social connection schema. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptServerSecret } from "./secret-crypto.server";
import { ProviderError } from "./social-provider-error";

const inflight = new Map<string, Promise<{ token: string; connection: any }>>();
export async function withSocialTokenRefresh(
  original: any,
  refresh: (connection: any) => Promise<string>,
  force = false,
) {
  const key = `${original.user_id || "server"}:${original.id}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = resolveToken(original, refresh, force);
    inflight.set(key, pending);
  }
  try {
    const result = await pending;
    Object.assign(original, result.connection);
    return result.token;
  } finally {
    if (inflight.get(key) === pending) inflight.delete(key);
  }
}

async function resolveToken(
  original: any,
  refresh: (connection: any) => Promise<string>,
  force: boolean,
) {
  const db = supabaseAdmin as any;
  async function latest() {
    let query = db
      .from("social_connections")
      .select(
        "id,user_id,provider,access_token,refresh_token,token_expires_at,status,reauth_required,connection_health,last_error",
      )
      .eq("id", original.id);
    if (original.user_id) query = query.eq("user_id", original.user_id);
    const { data, error } = await query.maybeSingle();
    if (error)
      throw new ProviderError(
        "Connection access could not be loaded. Retrying shortly.",
        "refresh_unavailable",
        true,
        503,
      );
    if (!data || data.status === "revoked" || !data.access_token)
      throw new ProviderError(
        "Reconnect this account to restore access.",
        "reconnect_required",
        false,
        401,
      );
    return { ...original, ...data };
  }
  const needsRefresh = (row: any) => {
    const horizon = row.provider === "threads" ? 3 * 86400_000 : row.refresh_token ? 5 * 60_000 : 0;
    const expires = Date.parse(row.token_expires_at || "");
    return (
      row.status === "expired" ||
      (Number.isFinite(expires) && expires <= Date.now() + horizon) ||
      (force && row.access_token === original.access_token)
    );
  };
  let connection = await latest();
  if (!needsRefresh(connection))
    return { token: await decryptServerSecret(connection.access_token, "social"), connection };
  const lease = crypto.randomUUID();
  const claim = await db.rpc("claim_social_token_refresh", {
    p_connection_id: connection.id,
    p_lease_id: lease,
  });
  if (claim.error || claim.data !== true)
    throw new ProviderError(
      "Account access is being renewed. Retrying shortly.",
      "refresh_in_progress",
      true,
      503,
      30,
    );
  try {
    connection = await latest();
    if (!needsRefresh(connection))
      return { token: await decryptServerSecret(connection.access_token, "social"), connection };
    let token: string;
    try {
      token = await refresh({ ...connection, token_refresh_lease_id: lease });
    } catch (error) {
      // A user may finish OAuth while an older refresh request is in flight.
      // Use the newly saved authorization instead of reporting its predecessor's failure.
      const replacement = await latest();
      if (replacement.access_token !== connection.access_token && !needsRefresh(replacement)) {
        return {
          token: await decryptServerSecret(replacement.access_token, "social"),
          connection: replacement,
        };
      }
      if (error instanceof ProviderError) {
        if (
          error.code === "invalid_token" ||
          (connection.provider === "threads" && error.code === "190") ||
          (connection.provider === "twitter" &&
            error.code === "invalid_request" &&
            /token.*invalid|invalid.*token|token.*expired/i.test(error.message))
        ) {
          throw new ProviderError(
            "Account authorization expired or was revoked. Reconnect this account.",
            "reconnect_required",
            false,
            401,
            null,
            error.providerCode,
          );
        }
        throw error;
      }
      // The token endpoint is not a publishing operation. A network timeout here
      // is safe to retry and must not produce an unknown publish outcome.
      throw new ProviderError(
        "Account access could not be renewed yet. Retrying shortly.",
        "refresh_unavailable",
        true,
        503,
      );
    }
    const updated = await latest();
    // OAuth reconnects can replace credentials while a refresh is finishing.
    const savedToken = await decryptServerSecret(updated.access_token, "social");
    return { token: savedToken === token ? token : savedToken, connection: updated };
  } finally {
    await db
      .from("social_connections")
      .update({ token_refresh_lease_id: null, token_refresh_lease_until: null })
      .eq("id", connection.id)
      .eq("token_refresh_lease_id", lease);
  }
}
