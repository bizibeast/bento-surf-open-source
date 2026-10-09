import { xAccountCapabilities } from "./x-account";

export async function fetchXAccountCapabilities(token: string) {
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
  return xAccountCapabilities(payload.data.subscription_type, payload.data.verified_type);
}
