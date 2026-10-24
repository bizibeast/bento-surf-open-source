type CloudflareCharge = {
  id?: string;
  type?: string;
  status?: string;
  amount?: number;
  amount_to_pay?: number;
  amount_remaining?: number;
  currency?: string;
  occurred_at?: string;
  description?: string;
  invoice_id?: string;
};

type CloudflareHistory = {
  success?: boolean;
  result?: CloudflareCharge[];
  result_info?: { page?: number; per_page?: number; total_count?: number; next_page?: boolean };
};

const CACHE_MS = 60_000;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MAX_PAGE_BYTES = 262_144;
const REQUEST_TIMEOUT_MS = 8_000;

export type CloudflareSpendReport = {
  status: "current" | "unconfigured" | "auth_failed" | "unavailable" | "partial";
  rows: FounderSpendRow[];
  checkedAt: string | null;
  failureReason:
    | "timeout"
    | "network"
    | "invalid_response"
    | "http"
    | "history_limit"
    | "amount_missing"
    | "reconciliation_unavailable"
    | null;
  httpStatus: number | null;
  missingAmountCount?: number;
  reconciledInvoiceCount?: number;
};

type UnpricedInvoice = {
  id: string;
  invoiceId: string | null;
  currency: string;
  occurredAt: string;
};
type BillingHistoryReport = CloudflareSpendReport & { unpriced?: UnpricedInvoice[] };

export type InvoiceAmountReconciliation = {
  provider: string;
  provider_account_id: string;
  provider_invoice_id: string;
  provider_invoice_date: string;
  amount_minor: number;
  currency: string;
  evidence_reference: string;
  evidence_sha256: string;
  evidence_verified_at: string;
  evidence_verified_by: string;
};

function matchingReconciliation(
  row: InvoiceAmountReconciliation,
  accountId: string,
  invoice: UnpricedInvoice,
) {
  return (
    row.provider === "Cloudflare" &&
    row.provider_account_id === accountId &&
    row.provider_invoice_id === invoice.invoiceId &&
    row.provider_invoice_date === invoice.occurredAt.slice(0, 10) &&
    row.currency === invoice.currency &&
    Number.isSafeInteger(row.amount_minor) &&
    row.amount_minor >= 0 &&
    typeof row.evidence_reference === "string" &&
    row.evidence_reference.length > 0 &&
    row.evidence_reference.length <= 500 &&
    /^[a-f0-9]{64}$/.test(row.evidence_sha256) &&
    Number.isFinite(Date.parse(row.evidence_verified_at)) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.evidence_verified_by)
  );
}

const PAID_CHARGE_STATUSES = ["paid", "completed", "succeeded", "success", "processed"];

function isSettledBillableEntry(item: CloudflareCharge) {
  const status = item.status?.toLowerCase();
  return item.type === "invoice"
    ? status === "closed" && item.amount_to_pay === 0 && item.amount_remaining === 0
    : item.type === "charge" &&
        Boolean(status && PAID_CHARGE_STATUSES.includes(status)) &&
        !(typeof item.amount_to_pay === "number" && item.amount_to_pay > 0);
}

export type FounderSpendRow = {
  id: string;
  provider: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  description: string;
  source: "cloudflare" | "manual";
  amountSource?: "verified_invoice";
};

export function normalizeCloudflareCharge(charge: CloudflareCharge): FounderSpendRow | null {
  // Payments settle charges and must not be counted a second time.
  if (!isSettledBillableEntry(charge) || !charge.id || !charge.occurred_at) return null;
  if (!Number.isFinite(charge.amount) || (charge.amount ?? -1) < 0) return null;
  const currency = charge.currency?.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency ?? "")) return null;
  const occurredAt = Date.parse(charge.occurred_at);
  const amountMinor = Math.round((charge.amount ?? 0) * 100);
  if (!Number.isFinite(occurredAt) || !Number.isSafeInteger(amountMinor)) return null;
  return {
    id: charge.id,
    provider: "Cloudflare",
    amountMinor,
    currency: currency!,
    occurredAt: new Date(occurredAt).toISOString(),
    description: (charge.description ?? "Cloudflare settled invoice").slice(0, 160),
    source: "cloudflare",
  };
}

function report(
  status: CloudflareSpendReport["status"],
  checkedAt: string | null,
  details: Partial<CloudflareSpendReport> = {},
): CloudflareSpendReport {
  return { status, rows: [], checkedAt, failureReason: null, httpStatus: null, ...details };
}

class InvalidBillingResponse extends Error {}

async function readBillingHistory(response: Response): Promise<CloudflareHistory> {
  if (Number(response.headers.get("content-length")) > MAX_PAGE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new InvalidBillingResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_PAGE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new InvalidBillingResponse();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as CloudflareHistory | null;
  if (!payload?.success || !Array.isArray(payload.result) || payload.result.length > PAGE_SIZE)
    throw new InvalidBillingResponse();
  return payload;
}

/** Free account invoice reads only. No estimates, paid fallbacks or token creation. */
export function createCloudflareSpendReader({
  fetcher = globalThis.fetch.bind(globalThis),
  now = Date.now,
  loadReconciliations = async () => [],
}: {
  fetcher?: typeof fetch;
  now?: () => number;
  loadReconciliations?: (
    accountId: string,
    invoiceIds: string[],
  ) => Promise<InvoiceAmountReconciliation[]>;
} = {}) {
  // History is shared across reporting windows, including a moving current-day
  // end time. Only one account/credential lives in this bounded isolate cache.
  let cache: {
    token: string;
    accountId: string;
    expiresAt: number;
    value: Promise<BillingHistoryReport>;
  } | null = null;

  async function read(token: string, accountId: string): Promise<BillingHistoryReport> {
    const checkedAt = new Date(now()).toISOString();
    const rows = new Map<string, FounderSpendRow>();
    const seen = new Set<string>();
    const unpriced = new Map<string, UnpricedInvoice>();
    const finish = (
      status: CloudflareSpendReport["status"],
      details: Partial<CloudflareSpendReport>,
    ) => ({ ...report(status, checkedAt, details), unpriced: [...unpriced.values()] });
    let httpStatus: number | null = null;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = new URL(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/billing/history`,
        );
        url.searchParams.set("page", String(page));
        url.searchParams.set("per_page", String(PAGE_SIZE));
        const response = await fetcher(url, {
          method: "GET",
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          redirect: "manual",
          signal,
        });
        httpStatus = response.status;
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          return finish(
            response.status === 401 || response.status === 403
              ? "auth_failed"
              : page > 1
                ? "partial"
                : "unavailable",
            { rows: [...rows.values()], failureReason: "http", httpStatus },
          );
        }
        const payload = await readBillingHistory(response);
        const info = payload.result_info;
        if (info !== undefined && (!info || typeof info !== "object" || Array.isArray(info)))
          throw new InvalidBillingResponse();
        if (info?.page !== undefined && info.page !== page) throw new InvalidBillingResponse();
        if (info?.next_page !== undefined && typeof info.next_page !== "boolean")
          throw new InvalidBillingResponse();
        const total = info?.total_count;
        if (total !== undefined && (!Number.isSafeInteger(total) || total < 0))
          throw new InvalidBillingResponse();
        const priorCount = seen.size;
        for (const item of payload.result!) {
          if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id)
            throw new InvalidBillingResponse();
          if (
            ["charge", "invoice"].includes(item.type || "") &&
            ((item.status !== undefined && typeof item.status !== "string") ||
              (item.currency !== undefined && typeof item.currency !== "string") ||
              (item.description !== undefined && typeof item.description !== "string") ||
              (item.amount_to_pay !== undefined &&
                (typeof item.amount_to_pay !== "number" || !Number.isFinite(item.amount_to_pay))) ||
              (item.amount_remaining !== undefined &&
                (typeof item.amount_remaining !== "number" ||
                  !Number.isFinite(item.amount_remaining))))
          )
            throw new InvalidBillingResponse();
          if (isSettledBillableEntry(item) && item.amount === undefined) {
            const at = Date.parse(item.occurred_at || "");
            const currency = item.currency?.toUpperCase();
            if (!Number.isFinite(at) || !/^[A-Z]{3}$/.test(currency || ""))
              throw new InvalidBillingResponse();
            if (!rows.has(item.id))
              unpriced.set(item.id, {
                id: item.id,
                invoiceId:
                  typeof item.invoice_id === "string" && item.invoice_id.length > 0
                    ? item.invoice_id
                    : null,
                currency: currency!,
                occurredAt: new Date(at).toISOString(),
              });
            seen.add(item.id);
            continue;
          }
          seen.add(item.id);
          const charge = normalizeCloudflareCharge(item);
          if (charge) {
            rows.set(charge.id, charge);
            unpriced.delete(charge.id);
          } else if (
            ["charge", "invoice"].includes(item.type || "") &&
            (!item.status ||
              PAID_CHARGE_STATUSES.includes(item.status.toLowerCase()) ||
              (item.type === "invoice" && item.status.toLowerCase() === "closed"))
          )
            throw new InvalidBillingResponse();
        }
        if (info?.next_page === false) {
          if (total !== undefined && seen.size < total) throw new InvalidBillingResponse();
          return finish("current", { rows: [...rows.values()], httpStatus });
        }
        if (total !== undefined && seen.size >= total && info?.next_page !== true)
          return finish("current", { rows: [...rows.values()], httpStatus });
        if (payload.result!.length === 0) {
          if ((total !== undefined && seen.size < total) || info?.next_page === true)
            throw new InvalidBillingResponse();
          return finish("current", { rows: [...rows.values()], httpStatus });
        }
        if (seen.size === priorCount) throw new InvalidBillingResponse();
        // Do not assume the provider honored per_page=100. Some accounts return
        // smaller pages; absent totals require an empty page to prove completion.
      }
      return finish("partial", {
        rows: [...rows.values()],
        failureReason: "history_limit",
        httpStatus,
      });
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? error.name : null;
      const failureReason =
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : error instanceof InvalidBillingResponse || error instanceof SyntaxError
            ? "invalid_response"
            : "network";
      return finish(seen.size ? "partial" : "unavailable", {
        rows: [...rows.values()],
        failureReason,
        httpStatus,
      });
    }
  }

  return async (
    periodStart: string,
    periodEnd: string,
    credentials: { token?: string; accountId?: string },
  ): Promise<CloudflareSpendReport> => {
    const token = credentials.token?.trim();
    const accountId = credentials.accountId?.trim();
    if (!token || !accountId) return report("unconfigured", null);
    const start = Date.parse(periodStart);
    const end = Date.parse(periodEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      return report("unavailable", null, { failureReason: "invalid_response" });
    if (
      !cache ||
      cache.token !== token ||
      cache.accountId !== accountId ||
      cache.expiresAt <= now()
    )
      cache = { token, accountId, expiresAt: now() + CACHE_MS, value: read(token, accountId) };
    const { unpriced = [], ...history } = await cache.value;
    const pending = unpriced.filter(
      (invoice) => Date.parse(invoice.occurredAt) >= start && Date.parse(invoice.occurredAt) < end,
    );
    const invoiceIds = [
      ...new Set(pending.flatMap((invoice) => (invoice.invoiceId ? [invoice.invoiceId] : []))),
    ];
    let reconciliations: InvoiceAmountReconciliation[] = [];
    let reconciliationUnavailable = false;
    if (invoiceIds.length) {
      try {
        // Provider history is cached; operator evidence is read fresh so a
        // correction or removal cannot survive in a cached displayed total.
        reconciliations = await loadReconciliations(accountId, invoiceIds);
      } catch {
        reconciliationUnavailable = true;
      }
    }
    const reconciled: FounderSpendRow[] = [];
    for (const invoice of pending) {
      if (!invoice.invoiceId) continue;
      const matches = reconciliations.filter((row) =>
        matchingReconciliation(row, accountId, invoice),
      );
      if (matches.length !== 1) continue;
      reconciled.push({
        id: invoice.id,
        provider: "Cloudflare",
        currency: invoice.currency,
        amountMinor: matches[0].amount_minor,
        occurredAt: invoice.occurredAt,
        description: "Cloudflare settled invoice (verified PDF amount)",
        source: "cloudflare",
        amountSource: "verified_invoice",
      });
    }
    const missingAmountCount = pending.length - reconciled.length;
    return {
      ...history,
      ...(history.status === "current" && missingAmountCount
        ? {
            status: "partial" as const,
            failureReason: reconciliationUnavailable
              ? ("reconciliation_unavailable" as const)
              : ("amount_missing" as const),
          }
        : {}),
      missingAmountCount,
      reconciledInvoiceCount: reconciled.length,
      rows: [
        ...history.rows.filter((row) => {
          const at = Date.parse(row.occurredAt);
          return at >= start && at < end;
        }),
        ...reconciled,
      ],
    };
  };
}

const readCloudflareSpend = createCloudflareSpendReader({
  async loadReconciliations(accountId, invoiceIds) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("founder_service_expenses" as never)
      .select(
        "provider,provider_account_id,provider_invoice_id,provider_invoice_date,amount_minor,currency,evidence_reference,evidence_sha256,evidence_verified_at,evidence_verified_by" as never,
      )
      .eq("provider", "Cloudflare")
      .eq("provider_account_id", accountId)
      .in("provider_invoice_id", invoiceIds.slice(0, 500))
      .limit(500)
      .abortSignal(AbortSignal.timeout(3_000));
    if (error) throw new Error("Invoice reconciliation unavailable");
    return (data || []) as unknown as InvoiceAmountReconciliation[];
  },
});

export async function getCloudflareSpend(periodStart: string, periodEnd: string) {
  return readCloudflareSpend(periodStart, periodEnd, {
    token: process.env.CLOUDFLARE_BILLING_API_TOKEN,
    accountId: process.env.CLOUDFLARE_BILLING_ACCOUNT_ID,
  });
}
