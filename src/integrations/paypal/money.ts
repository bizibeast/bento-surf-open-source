export const PAYPAL_SUPPORTED_CURRENCIES = new Set([
  "aud",
  "brl",
  "cad",
  "cny",
  "czk",
  "dkk",
  "eur",
  "gbp",
  "hkd",
  "huf",
  "ils",
  "jpy",
  "myr",
  "mxn",
  "nok",
  "nzd",
  "php",
  "pln",
  "rub",
  "sgd",
  "sek",
  "chf",
  "twd",
  "thb",
  "usd",
]);

export const PAYPAL_ZERO_DECIMAL_CURRENCIES = new Set(["huf", "jpy", "twd"]);

export function paypalMoney(amountInMinorUnits: number, currency: string) {
  const normalized = currency.toLowerCase();
  if (!PAYPAL_SUPPORTED_CURRENCIES.has(normalized)) {
    throw new Error(`${normalized.toUpperCase()} is not supported by PayPal checkout.`);
  }
  return PAYPAL_ZERO_DECIMAL_CURRENCIES.has(normalized)
    ? String(Math.round(amountInMinorUnits))
    : (Math.round(amountInMinorUnits) / 100).toFixed(2);
}

export function paypalMinorUnits(value: unknown, currency: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0)
    throw new Error("PayPal returned an invalid amount.");
  return Math.round(
    numeric * (PAYPAL_ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()) ? 1 : 100),
  );
}
