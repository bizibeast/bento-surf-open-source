type CloudflareCharge = {
  id?: string;
  type?: string;
  status?: string;
  amount?: number;
  currency?: string;
  occurred_at?: string;
  description?: string;
};

type CloudflareHistory = {
  success?: boolean;
  result?: CloudflareCharge[];
  result_info?: { page?: number; total_count?: number };
};

export type FounderSpendRow = {
  id: string;
  provider: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  description: string;
  source: "cloudflare" | "manual";
};

export function normalizeCloudflareCharge(charge: CloudflareCharge): FounderSpendRow | null {
  // Payments settle charges and must not be counted a second time.
  if (charge.type !== "charge" || !charge.id || !charge.occurred_at) return null;
  if (
    charge.status &&
    !["paid", "completed", "succeeded", "success", "processed"].includes(
      charge.status.toLowerCase(),
    )
  )
    return null;
  if (!Number.isFinite(charge.amount) || (charge.amount ?? -1) < 0) return null;
  if (!/^[A-Z]{3}$/.test(charge.currency ?? "")) return null;
  return {
    id: charge.id,
    provider: "Cloudflare",
    amountMinor: Math.round((charge.amount ?? 0) * 100),
    currency: charge.currency!,
    occurredAt: charge.occurred_at,
    description: (charge.description ?? "Cloudflare charge").slice(0, 160),
    source: "cloudflare",
  };
}

export async function getCloudflareSpend(
  periodStart: string,
  periodEnd: string,
): Promise<{
  status: "current" | "unconfigured" | "unavailable" | "partial";
  rows: FounderSpendRow[];
}> {
  const token = process.env.CLOUDFLARE_BILLING_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_BILLING_ACCOUNT_ID;
  if (!token || !accountId) return { status: "unconfigured", rows: [] };

  const rows: FounderSpendRow[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/billing/history`,
      );
      url.searchParams.set("page", String(page));
      url.searchParams.set("per_page", "100");
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { status: "unavailable", rows: [] };
      const payload = (await response.json()) as CloudflareHistory;
      if (!payload.success || !Array.isArray(payload.result))
        return { status: "unavailable", rows: [] };
      for (const item of payload.result) {
        const charge = normalizeCloudflareCharge(item);
        if (charge && charge.occurredAt >= periodStart && charge.occurredAt < periodEnd)
          rows.push(charge);
      }
      if (page * 100 >= (payload.result_info?.total_count ?? payload.result.length))
        return { status: "current", rows };
    }
    return { status: "partial", rows };
  } catch {
    return { status: "unavailable", rows: [] };
  }
}
