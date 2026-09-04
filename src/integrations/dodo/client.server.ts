// Server-only Dodo Payments client. Never import from client code.
import DodoPayments from "dodopayments";

function createDodoClient() {
  const bearerToken = process.env.DODO_PAYMENTS_API_KEY;
  if (!bearerToken) {
    throw new Error("Missing Dodo environment variable: DODO_PAYMENTS_API_KEY");
  }
  const environment =
    process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode";

  return new DodoPayments({
    bearerToken,
    // Used by dodo.webhooks.unwrap() to verify inbound webhook signatures.
    webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY ?? null,
    environment,
  });
}

let _dodo: ReturnType<typeof createDodoClient> | undefined;

/** Lazily-constructed server-side Dodo client (reads env on first use). */
export const dodo = new Proxy({} as ReturnType<typeof createDodoClient>, {
  get(_, prop, receiver) {
    if (!_dodo) _dodo = createDodoClient();
    return Reflect.get(_dodo, prop, receiver);
  },
});
