import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { ArrowLeft, Printer, ReceiptText, ShieldCheck } from "lucide-react";
import { getCustomerReceipt } from "@/lib/customer-library.functions";
import { formatCommerceMoney } from "@/lib/commerce";
import { BentoFullLogo } from "@/components/BentoBrand";
import { useWebMcpTools, webMcpResult } from "@/lib/webmcp";

export const Route = createFileRoute("/library/receipts/$orderId")({
  head: () => ({
    meta: [
      { title: "Purchase receipt | bento.surf" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  loader: ({ params }) => getCustomerReceipt({ data: { orderId: params.orderId } }),
  component: CustomerReceiptPage,
});

function CustomerReceiptPage() {
  const receipt = Route.useLoaderData();
  const webMcpTools = useMemo(
    () =>
      receipt
        ? [
            {
              name: "bento_get_customer_receipt",
              title: "Get customer receipt",
              description:
                "Returns a safe summary of the signed-in customer's visible receipt without the order ID or customer email.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: true, untrustedContentHint: true },
              execute: () =>
                webMcpResult("Loaded the customer receipt summary.", {
                  receipt: {
                    productTitle: receipt.product.title,
                    creatorName: receipt.creator.name,
                    creatorUsername: receipt.creator.username,
                    status: receipt.order.status,
                    grossAmount: receipt.order.grossAmount,
                    refundedAmount: receipt.order.refundedAmount,
                    taxAmount: receipt.order.taxAmount,
                    currency: receipt.order.currency,
                    paidAt: receipt.order.paidAt,
                    createdAt: receipt.order.createdAt,
                    disputeStatus: receipt.order.disputeStatus,
                  },
                }),
            },
            {
              name: "bento_print_customer_receipt",
              title: "Print customer receipt",
              description: "Opens the browser print dialog for the currently visible receipt.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: false, untrustedContentHint: false },
              execute: () => {
                window.print();
                return webMcpResult("Opened the browser print dialog.", { opened: true });
              },
            },
          ]
        : [],
    [receipt],
  );
  useWebMcpTools(webMcpTools);
  if (!receipt) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f4f6fb] px-4 py-10 text-[#17213a]">
        <section className="w-full max-w-md rounded-[32px] border border-black/[0.06] bg-white p-7 text-center shadow-sm sm:p-9">
          <ReceiptText className="mx-auto size-8 text-[#17213a]/25" />
          <h1 className="mt-4 font-display text-3xl">Receipt unavailable.</h1>
          <p className="mt-2 text-sm leading-6 text-[#17213a]/48">
            Sign in to the customer library with the email used at checkout, then try again.
          </p>
          <a
            href="/library/"
            className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-[#17213a] px-5 py-3 text-sm font-semibold text-white"
          >
            <ArrowLeft className="size-4" /> Customer library
          </a>
        </section>
      </main>
    );
  }

  const { order, product, creator } = receipt;
  const purchasedAt = new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(order.paidAt || order.createdAt));
  const totalAfterRefund = Math.max(0, order.grossAmount - order.refundedAmount);

  return (
    <main className="min-h-screen bg-[#f4f6fb] px-4 py-8 text-[#17213a] sm:px-6 sm:py-12">
      <section className="mx-auto w-full max-w-2xl overflow-hidden rounded-[34px] border border-black/[0.06] bg-white shadow-[0_36px_100px_-62px_rgba(23,33,58,.65)]">
        <header className="flex flex-wrap items-center gap-3 border-b border-black/[0.06] px-5 py-5 sm:px-8">
          <a
            href="/library/"
            className="inline-flex size-10 items-center justify-center rounded-2xl border border-black/[0.07]"
            aria-label="Back to customer library"
          >
            <ArrowLeft className="size-4" />
          </a>
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#3478f6]">
              Purchase receipt
            </div>
            <BentoFullLogo className="mt-1 h-6 w-auto" />
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="print:hidden inline-flex items-center gap-2 rounded-2xl border border-black/[0.07] px-4 py-2.5 text-xs font-semibold"
          >
            <Printer className="size-4" /> Print
          </button>
        </header>

        <div className="p-5 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="font-display text-4xl leading-none sm:text-5xl">{product.title}</h1>
              <p className="mt-3 text-sm text-[#17213a]/48">
                Sold by {creator.name}
                {creator.username ? ` · @${creator.username}` : ""}
              </p>
            </div>
            <ReceiptStatus status={order.status} />
          </div>

          <dl className="mt-8 grid gap-px overflow-hidden rounded-[24px] border border-black/[0.06] bg-black/[0.06] sm:grid-cols-2">
            <ReceiptDetail label="Order" value={`#${order.id}`} mono />
            <ReceiptDetail label="Purchased" value={purchasedAt} />
            <ReceiptDetail label="Customer" value={order.buyerName || "Customer"} />
            <ReceiptDetail label="Email" value={order.buyerEmail} />
          </dl>

          <div className="mt-6 rounded-[24px] bg-[#f7f8fc] p-5">
            <MoneyRow
              label="Purchase total"
              value={formatCommerceMoney(order.grossAmount, order.currency)}
            />
            {order.taxAmount > 0 && (
              <p className="mt-1 text-[11px] text-[#17213a]/38">
                Includes {formatCommerceMoney(order.taxAmount, order.currency)} in applicable tax.
              </p>
            )}
            {order.refundedAmount > 0 && (
              <MoneyRow
                label="Refunded"
                value={`−${formatCommerceMoney(order.refundedAmount, order.currency)}`}
                muted
              />
            )}
            <div className="my-4 h-px bg-black/[0.07]" />
            <MoneyRow
              label={order.refundedAmount > 0 ? "Total after refunds" : "Total paid"}
              value={formatCommerceMoney(totalAfterRefund, order.currency)}
              strong
            />
          </div>

          {order.disputeStatus && (
            <div
              className={`mt-6 rounded-[22px] border p-4 text-xs leading-5 ${
                order.disputeStatus === "won" || order.disputeStatus === "canceled"
                  ? "border-emerald-100 bg-emerald-50 text-emerald-800"
                  : "border-red-100 bg-red-50 text-red-700"
              }`}
            >
              <span className="font-semibold capitalize">
                Dispute {order.disputeStatus.replaceAll("_", " ")}.
              </span>{" "}
              {order.disputeStatus === "won" || order.disputeStatus === "canceled"
                ? "Your purchase access has been restored where it is still eligible."
                : "Purchase access is suspended while this payment dispute is unresolved."}
              {order.disputeReason ? ` Reason: ${order.disputeReason}.` : ""}
            </div>
          )}

          <div className="mt-6 flex items-start gap-3 rounded-[22px] border border-emerald-100 bg-emerald-50 p-4 text-emerald-800">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <p className="text-xs leading-5">
              Bento charges 0% platform fee. Payment processing and merchant-of-record fees, when
              applicable, are handled by the connected payment provider.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function ReceiptDetail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0 bg-white p-4">
      <dt className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#17213a]/35">
        {label}
      </dt>
      <dd className={`mt-1 break-words text-sm ${mono ? "font-mono text-xs" : "font-medium"}`}>
        {value}
      </dd>
    </div>
  );
}

function MoneyRow({
  label,
  value,
  muted = false,
  strong = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 ${
        strong ? "font-semibold" : "mt-3 text-sm"
      } ${muted ? "text-[#17213a]/48" : ""}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ReceiptStatus({ status }: { status: string }) {
  const label =
    status === "partially_refunded"
      ? "Partially refunded"
      : status === "refunded"
        ? "Refunded"
        : status === "paid"
          ? "Paid"
          : status === "disputed"
            ? "Disputed"
            : status;
  const isProblem = status === "disputed";
  return (
    <span
      className={`w-fit shrink-0 rounded-full px-3 py-1.5 text-[10px] font-semibold capitalize ${
        isProblem ? "bg-red-100 text-red-700" : "bg-[#e7f7ee] text-[#197a4d]"
      }`}
    >
      {label}
    </span>
  );
}
