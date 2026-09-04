type DodoPaymentAmount = {
  currency: string;
  total_amount: number;
  tax?: number | null;
};

type DodoPaymentSessionAmount = {
  currency: string;
  gross_amount: number;
};

export function assertDodoCreatorBusiness(
  eventBusinessId: string | null | undefined,
  connectionBusinessId: string,
  resource: string,
) {
  if (!eventBusinessId || eventBusinessId !== connectionBusinessId) {
    throw new Error(`Dodo ${resource} belongs to a different business.`);
  }
}

/**
 * Dodo's total_amount includes tax, while Bento stores the offer price before
 * provider-collected tax in the payment session. Both values are in the
 * currency's smallest unit.
 */
export function assertDodoPaymentAmount(
  payment: DodoPaymentAmount,
  session: DodoPaymentSessionAmount,
) {
  if (payment.currency.toLowerCase() !== session.currency.toLowerCase()) {
    throw new Error("Dodo payment currency does not match the Bento checkout.");
  }
  const total = Number(payment.total_amount);
  const tax = Math.max(0, Number(payment.tax || 0));
  const expected = Number(session.gross_amount);
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(tax) ||
    !Number.isSafeInteger(expected) ||
    total < tax ||
    total - tax !== expected
  ) {
    throw new Error("Dodo payment amount does not match the Bento checkout.");
  }
}
