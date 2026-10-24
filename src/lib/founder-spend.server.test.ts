import { describe, expect, it, vi } from "vitest";
import {
  createCloudflareSpendReader,
  normalizeCloudflareCharge,
  type InvoiceAmountReconciliation,
} from "./founder-spend.server";

const credentials = { token: "private-billing-token", accountId: "billing-account" };
const period = ["2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"] as const;
const charge = (id = "charge-1", occurred_at = "2026-10-09T10:00:00Z") => ({
  id,
  type: "charge",
  status: "paid",
  amount: 20.99,
  amount_to_pay: 0,
  currency: "USD",
  occurred_at,
});
function history(result: unknown[], result_info?: Record<string, number | boolean>) {
  return new Response(JSON.stringify({ success: true, result, result_info }));
}

describe("Cloudflare billing normalization", () => {
  it("counts paid charges in minor units without counting settlements or pending charges", () => {
    const base = {
      id: "invoice-1",
      amount: 20.99,
      currency: "USD",
      occurred_at: "2026-10-09T10:00:00Z",
    };
    expect(normalizeCloudflareCharge({ ...base, type: "charge", status: "paid" })).toMatchObject({
      amountMinor: 2099,
      currency: "USD",
    });
    expect(normalizeCloudflareCharge({ ...base, type: "payment", status: "paid" })).toBeNull();
    expect(normalizeCloudflareCharge({ ...base, type: "charge", status: "pending" })).toBeNull();
    expect(normalizeCloudflareCharge({ ...base, type: "charge", amount: -20 })).toBeNull();
  });

  it("requires settled valid charges and normalizes timestamp offsets", () => {
    expect(normalizeCloudflareCharge({ ...charge(), status: undefined })).toBeNull();
    expect(normalizeCloudflareCharge({ ...charge(), amount_to_pay: 1 })).toBeNull();
    expect(normalizeCloudflareCharge({ ...charge(), occurred_at: "invalid" })).toBeNull();
    expect(normalizeCloudflareCharge({ ...charge(), amount: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(normalizeCloudflareCharge(charge("offset", "2026-10-09T15:30:00+05:30"))).toHaveProperty(
      "occurredAt",
      "2026-10-09T10:00:00.000Z",
    );
  });
});

describe("bounded Cloudflare invoice history", () => {
  it("fills only an exact missing invoice amount from verified evidence and preserves explicit API zero", async () => {
    const accountId = "a".repeat(32);
    const invoice = {
      ...charge("missing"),
      amount: undefined,
      invoice_id: "provider-missing",
      type: "invoice",
      status: "CLOSED",
      amount_remaining: 0,
    };
    const proof: InvoiceAmountReconciliation = {
      provider: "Cloudflare",
      provider_account_id: accountId,
      provider_invoice_id: "provider-missing",
      provider_invoice_date: "2026-10-09",
      amount_minor: 0,
      currency: "USD",
      evidence_reference: "Invoice PDF fixture",
      evidence_sha256: "a".repeat(64),
      evidence_verified_at: "2026-10-10T00:00:00Z",
      evidence_verified_by: "00000000-0000-4000-8000-000000000001",
    };
    const fetcher = vi.fn(async () =>
      history(
        [
          invoice,
          { ...invoice, id: "explicit-zero", invoice_id: "provider-zero", amount: 0 },
          { ...invoice, id: "explicit-paid", invoice_id: "provider-paid", amount: 2.25 },
        ],
        { next_page: false },
      ),
    );
    const loadReconciliations = vi.fn(async () => [
      proof,
      { ...proof, provider_invoice_id: "provider-zero", amount_minor: 9999 },
      { ...proof, provider_invoice_id: "provider-paid", amount_minor: 9999 },
    ]);
    const result = await createCloudflareSpendReader({ fetcher, loadReconciliations })(...period, {
      ...credentials,
      accountId,
    });
    expect(loadReconciliations).toHaveBeenCalledWith(accountId, ["provider-missing"]);
    expect(result).toMatchObject({
      status: "current",
      missingAmountCount: 0,
      reconciledInvoiceCount: 1,
    });
    expect(result.rows.map((row) => [row.id, row.amountMinor])).toEqual([
      ["explicit-zero", 0],
      ["explicit-paid", 225],
      ["missing", 0],
    ]);
    expect(result.rows.find((row) => row.id === "missing")?.amountSource).toBe("verified_invoice");
    expect(JSON.stringify(result)).not.toMatch(
      /evidence_sha256|evidence_verified_by|Invoice PDF fixture|provider-missing/,
    );
  });

  it("rejects mismatched, incomplete, or ambiguous invoice evidence and keeps future unknowns unknown", async () => {
    const accountId = "a".repeat(32);
    const invoice = {
      ...charge(),
      amount: undefined,
      invoice_id: "provider-invoice",
      type: "invoice",
      status: "CLOSED",
      amount_remaining: 0,
    };
    const proof: InvoiceAmountReconciliation = {
      provider: "Cloudflare",
      provider_account_id: accountId,
      provider_invoice_id: "provider-invoice",
      provider_invoice_date: "2026-10-09",
      amount_minor: 0,
      currency: "USD",
      evidence_reference: "Invoice PDF fixture",
      evidence_sha256: "a".repeat(64),
      evidence_verified_at: "2026-10-10T00:00:00Z",
      evidence_verified_by: "00000000-0000-4000-8000-000000000001",
    };
    for (const rows of [
      [],
      [proof, proof],
      [{ ...proof, provider_account_id: "b".repeat(32) }],
      [{ ...proof, provider_invoice_id: "other" }],
      [{ ...proof, currency: "EUR" }],
      [{ ...proof, provider_invoice_date: "2026-10-08" }],
      [{ ...proof, evidence_sha256: "" }],
      [{ ...proof, evidence_reference: "" }],
      [{ ...proof, evidence_verified_by: "" }],
      [{ ...proof, amount_minor: -1 }],
    ]) {
      const result = await createCloudflareSpendReader({
        fetcher: async () => history([invoice], { next_page: false }),
        loadReconciliations: async () => rows,
      })(...period, { ...credentials, accountId });
      expect(result).toMatchObject({
        status: "partial",
        failureReason: "amount_missing",
        missingAmountCount: 1,
        reconciledInvoiceCount: 0,
      });
      expect(result.rows).toEqual([]);
    }
  });

  it("reconciles cached provider history against fresh operator evidence and exposes read failures", async () => {
    const accountId = "a".repeat(32);
    const invoice = {
      ...charge(),
      amount: undefined,
      invoice_id: "provider-invoice",
      type: "invoice",
      status: "CLOSED",
      amount_remaining: 0,
    };
    let proofs: InvoiceAmountReconciliation[] = [];
    const fetcher = vi.fn(async () => history([invoice], { next_page: false }));
    const loadReconciliations = vi.fn(async () => proofs);
    const read = createCloudflareSpendReader({ fetcher, loadReconciliations });
    expect((await read(...period, { ...credentials, accountId })).status).toBe("partial");
    proofs = [
      {
        provider: "Cloudflare",
        provider_account_id: accountId,
        provider_invoice_id: "provider-invoice",
        provider_invoice_date: "2026-10-09",
        amount_minor: 0,
        currency: "USD",
        evidence_reference: "Invoice PDF",
        evidence_sha256: "a".repeat(64),
        evidence_verified_at: "2026-10-10T00:00:00Z",
        evidence_verified_by: "00000000-0000-4000-8000-000000000001",
      },
    ];
    expect((await read(...period, { ...credentials, accountId })).status).toBe("current");
    proofs = [];
    expect((await read(...period, { ...credentials, accountId })).status).toBe("partial");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(loadReconciliations).toHaveBeenCalledTimes(3);
    loadReconciliations.mockRejectedValueOnce(new Error("private database error"));
    const failed = await read(...period, { ...credentials, accountId });
    expect(failed).toMatchObject({
      status: "partial",
      failureReason: "reconciliation_unavailable",
    });
    expect(JSON.stringify(failed)).not.toContain("private");
  });

  it("handles the live invoice/CLOSED shape, lowercase currency, and next_page=false without inventing missing amounts", async () => {
    // Same fields as the observed API response; IDs, dates and amounts are fictional.
    const invoice = {
      id: "invoice-one",
      type: "invoice",
      status: "CLOSED",
      occurred_at: "2026-10-09T00:00:00Z",
      amount: 4.25,
      amount_to_pay: 0,
      amount_remaining: 0,
      ready_to_pay: false,
      currency: "usd",
      invoice_id: "private-invoice",
      receipt_id: "private-receipt",
      source: "stripe",
    };
    const unpriced = { ...invoice, amount: undefined };
    const fetcher = vi.fn(async () =>
      history(
        [
          invoice,
          { ...invoice, id: "invoice-two", amount: 3.75 },
          { ...unpriced, id: "invoice-three", occurred_at: "2026-09-09T00:00:00Z" },
          { ...unpriced, id: "invoice-four", occurred_at: "2026-08-09T00:00:00Z" },
        ],
        { page: 1, per_page: 50, next_page: false },
      ),
    );
    const read = createCloudflareSpendReader({ fetcher });
    const october = await read(...period, credentials);
    expect(october).toMatchObject({ status: "current", missingAmountCount: 0 });
    expect(october.rows.map(({ amountMinor, currency }) => ({ amountMinor, currency }))).toEqual([
      { amountMinor: 425, currency: "USD" },
      { amountMinor: 375, currency: "USD" },
    ]);
    const quarter = await read("2026-08-01T00:00:00Z", period[1], credentials);
    expect(quarter).toMatchObject({
      status: "partial",
      failureReason: "amount_missing",
      missingAmountCount: 2,
    });
    expect(quarter.rows).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(quarter)).not.toMatch(/private|stripe|unpricedAt/);
  });

  it("does not add payment or credit movements to settled invoice amounts", async () => {
    const fetcher = vi.fn(async () =>
      history(
        [
          { ...charge(), type: "invoice", status: "CLOSED", amount_remaining: 0, currency: "usd" },
          { ...charge("payment"), type: "payment" },
          { ...charge("credit"), type: "credit", amount: -5 },
          { ...charge("open"), type: "invoice", status: "OPEN", amount_remaining: 5 },
        ],
        { next_page: false },
      ),
    );
    const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
    expect(result.status).toBe("current");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].amountMinor).toBe(2099);
  });

  it("follows next_page=true without totals and rejects conflicting completeness metadata", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(history([charge("one")], { page: 1, next_page: true }))
      .mockResolvedValueOnce(history([charge("two")], { page: 2, next_page: false }));
    const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
    expect(result.status).toBe("current");
    expect(result.rows).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const conflict = vi.fn(async () => history([charge()], { next_page: false, total_count: 2 }));
    expect(
      await createCloudflareSpendReader({ fetcher: conflict })(...period, credentials),
    ).toMatchObject({ status: "partial", failureReason: "invalid_response" });
  });

  it("keeps missing credentials and invalid date ranges distinct from a zero invoice total", async () => {
    const fetcher = vi.fn();
    const read = createCloudflareSpendReader({ fetcher });
    expect(await read(...period, {})).toMatchObject({ status: "unconfigured", checkedAt: null });
    expect(await read("bad", period[1], credentials)).toMatchObject({
      status: "unavailable",
      failureReason: "invalid_response",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses inclusive start/exclusive end instants rather than lexical timestamp comparison", async () => {
    const fetcher = vi.fn(async () =>
      history(
        [
          charge("before", "2026-10-01T01:00:00+05:30"),
          charge("start", "2026-10-01T05:30:00+05:30"),
          charge("inside", "2026-10-31T23:59:59.999Z"),
          charge("end", "2026-11-01T00:00:00Z"),
        ],
        { total_count: 4 },
      ),
    );
    const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
    expect(result.status).toBe("current");
    expect(result.rows.map((row) => row.id)).toEqual(["start", "inside"]);
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(result)).not.toContain(credentials.token);
  });

  it("follows smaller provider pages until the actual total is reached", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return history([charge(`charge-${page}`)], { page, per_page: 1, total_count: 2 });
    });
    const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
    expect(result.status).toBe("current");
    expect(result.rows).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("requires an empty terminal page when the API omits pagination metadata", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(history([charge()]))
      .mockResolvedValueOnce(history([]));
    const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
    expect(result).toMatchObject({ status: "current" });
    expect(result.rows).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("deduplicates overlap and refuses to count a repeated page as complete", async () => {
    const overlap = vi
      .fn()
      .mockResolvedValueOnce(history([charge("one")], { total_count: 2 }))
      .mockResolvedValueOnce(history([charge("one"), charge("two")], { total_count: 2 }));
    const result = await createCloudflareSpendReader({ fetcher: overlap })(...period, credentials);
    expect(result.status).toBe("current");
    expect(result.rows).toHaveLength(2);
    const repeated = vi.fn(async () => history([charge()], { total_count: 2 }));
    const incomplete = await createCloudflareSpendReader({ fetcher: repeated })(
      ...period,
      credentials,
    );
    expect(incomplete).toMatchObject({ status: "partial", failureReason: "invalid_response" });
    expect(repeated).toHaveBeenCalledTimes(2);
  });

  it("withholds the total at the page ceiling and preserves rows after a later failure", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      history([charge(String(url))], { total_count: 6 }),
    );
    const limited = await createCloudflareSpendReader({ fetcher })(...period, credentials);
    expect(limited).toMatchObject({ status: "partial", failureReason: "history_limit" });
    expect(limited.rows).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
    const failed = vi
      .fn()
      .mockResolvedValueOnce(history([charge()], { total_count: 2 }))
      .mockResolvedValueOnce(new Response("private provider error", { status: 503 }));
    const partial = await createCloudflareSpendReader({ fetcher: failed })(...period, credentials);
    expect(partial).toMatchObject({ status: "partial", failureReason: "http", httpStatus: 503 });
    expect(partial.rows).toHaveLength(1);
    expect(JSON.stringify(partial)).not.toContain("private");
  });

  it("distinguishes rejected auth and rejects redirects without leaking provider details", async () => {
    for (const status of [401, 403, 302]) {
      const fetcher = vi.fn(
        async () =>
          new Response("private credential details", {
            status,
            headers: { location: "https://private.example/credential" },
          }),
      );
      const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
      expect(result).toMatchObject({
        status: status === 302 ? "unavailable" : "auth_failed",
        failureReason: "http",
        httpStatus: status,
      });
      expect(JSON.stringify(result)).not.toMatch(/private|location/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects oversized, malformed, and falsely complete responses", async () => {
    for (const response of [
      new Response("x".repeat(270_000)),
      new Response("invalid json"),
      history([charge("bad", "invalid")], { total_count: 1 }),
      history([], { total_count: 2 }),
      history([charge()], { page: 2, total_count: 1 }),
    ]) {
      const fetcher = vi.fn(async () => response);
      const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
      expect(result.status).not.toBe("current");
      expect(result.failureReason).toBe("invalid_response");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("coalesces concurrent windows, expires after one minute, and isolates credential changes", async () => {
    let now = 0;
    const fetcher = vi.fn(async () => history([charge()], { total_count: 1 }));
    const read = createCloudflareSpendReader({ fetcher, now: () => now });
    const [october, november] = await Promise.all([
      read(...period, credentials),
      read("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", credentials),
      read(...period, credentials),
    ]);
    expect(october.rows).toHaveLength(1);
    expect(november.rows).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 59_999;
    await read(...period, credentials);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 60_001;
    await read(...period, credentials);
    await read(...period, { ...credentials, token: "rotated-token" });
    await read(...period, { ...credentials, accountId: "another-account" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("uses one timeout across all pages and does not retry an expired request", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
      signals.push(options!.signal as AbortSignal);
      if (signals.length === 1) return history([charge()], { total_count: 2 });
      throw new DOMException("private timeout detail", "TimeoutError");
    });
    const result = await createCloudflareSpendReader({ fetcher })(...period, credentials);
    expect(result).toMatchObject({ status: "partial", failureReason: "timeout" });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
