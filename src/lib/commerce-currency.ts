export const COMMERCE_CURRENCIES = ["usd", "inr", "eur", "gbp", "aud", "cad"] as const;

export type CommerceCurrency = (typeof COMMERCE_CURRENCIES)[number];

export const DEFAULT_COMMERCE_CURRENCY: CommerceCurrency = "usd";
export const commerceDefaultCurrencyQueryKey = ["commerce-default-currency"] as const;

export const COMMERCE_CURRENCY_LABELS: Record<CommerceCurrency, string> = {
  usd: "USD (US dollar)",
  inr: "INR (Indian rupee)",
  eur: "EUR (Euro)",
  gbp: "GBP (British pound)",
  aud: "AUD (Australian dollar)",
  cad: "CAD (Canadian dollar)",
};
