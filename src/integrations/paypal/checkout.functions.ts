import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { enforceRequestRateLimit } from "@/lib/request-security.server";
import { capturePayPalCommerceOrder } from "./checkout.server";

export const capturePayPalCheckout = createServerFn({ method: "POST" })
  .validator((input) =>
    z
      .object({
        sessionId: z.string().uuid(),
        captureToken: z.string().min(20).max(200),
        orderId: z.string().min(8).max(128),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await enforceRequestRateLimit("CHECKOUT_RATE_LIMITER", "paypal-capture");
    return capturePayPalCommerceOrder(data);
  });
