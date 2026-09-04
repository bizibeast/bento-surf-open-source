import { afterEach, describe, expect, it } from "vitest";
import { handleDirectPayPalWebhook, handlePayPalWebhook } from "./paypal/webhook.server";
import { handlePolarWebhook } from "./polar/webhook.server";
import { handleStripeWebhook } from "./stripe/webhook.server";
import { handleCreemWebhook } from "./creem/webhook.server";

const oversizedHeaders = {
  "content-length": String(1024 * 1024 + 1),
  "content-type": "application/json",
};

afterEach(() => {
  Reflect.deleteProperty(process.env, "STRIPE_CONNECT_WEBHOOK_SECRET");
});

describe("payment webhook request bounds", () => {
  it.each([
    ["Stripe", (request: Request) => handleStripeWebhook(request)],
    ["PayPal", (request: Request) => handlePayPalWebhook(request)],
    [
      "Polar",
      (request: Request) => handlePolarWebhook(request, "00000000-0000-4000-8000-000000000001"),
    ],
    [
      "Creem",
      (request: Request) => handleCreemWebhook(request, "00000000-0000-4000-8000-000000000001"),
    ],
  ])("rejects oversized %s payloads before verification or database work", async (_name, run) => {
    const response = await run(
      new Request("https://bento.surf/api/webhooks/test", {
        method: "POST",
        headers: oversizedHeaders,
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
  });

  it("bounds creator-owned PayPal webhooks before loading the connection", async () => {
    const response = await handleDirectPayPalWebhook(
      new Request("https://bento.surf/api/webhooks/paypal/direct/test", {
        method: "POST",
        headers: oversizedHeaders,
        body: "{}",
      }),
      "00000000-0000-4000-8000-000000000001",
    );

    expect(response.status).toBe(413);
  });

  it("returns a controlled response when the optional Stripe Connect webhook is disabled", async () => {
    const response = await handleStripeWebhook(
      new Request("https://app.bento.surf/api/webhooks/stripe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Stripe Connect webhook is not configured");
  });
});
