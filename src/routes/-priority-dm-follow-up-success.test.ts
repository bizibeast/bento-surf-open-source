import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/$username_.products.$productSlug_.success.tsx"),
  "utf8",
);
const commerce = readFileSync(resolve(process.cwd(), "src/lib/commerce.functions.ts"), "utf8");
const fulfillment = readFileSync(
  resolve(process.cwd(), "src/lib/commerce-fulfillment.server.ts"),
  "utf8",
);
const email = readFileSync(resolve(process.cwd(), "src/lib/email.server.ts"), "utf8");
const server = readFileSync(resolve(process.cwd(), "src/server.ts"), "utf8");

describe("Priority DM paid follow-up success", () => {
  it("replaces only confirmed follow-up success with the owned conversation", () => {
    const redirect = source.slice(
      source.indexOf("const priorityDmRequestId"),
      source.indexOf("const accessStatus"),
    );

    expect(redirect).toContain('confirmation.data?.state === "confirmed"');
    expect(redirect).toContain("if (!priorityDmRequestId) return");
    expect(redirect).toContain(
      "window.location.replace(`/library/priority-dm/${priorityDmRequestId}`)",
    );
    expect(source).toContain("Your order for");
  });

  it("builds paid follow-up checkout from the verified customer and conversation snapshot", () => {
    const checkout = commerce.slice(
      commerce.indexOf("export const createCommerceCheckout"),
      commerce.indexOf("export const getCommerceAccess"),
    );

    expect(checkout).toContain("priorityDmRequestId: uuidSchema.optional()");
    expect(checkout).toContain("await currentCustomerSession()");
    expect(checkout).toContain("await loadPriorityDmPaidFollowUp(");
    expect(checkout).toContain("freeFollowUpsRemaining > 0");
    expect(checkout).toContain("data.discountCode || data.bumpProductId || data.recordingAddon");
    expect(checkout).toContain("`Follow-up · ${product.title}`");
    expect(checkout).toContain("priorityDmFollowUpAnswer(priorityDmRequest.id, message)");
    expect(checkout).toContain("customerIdentity.customer.email_normalized");
    expect(checkout).toContain("customerIdentity ? customerIdentity.customer.name : data.name");
    expect(checkout).toContain('commerce_intent: "priority_dm_followup"');
  });

  it("returns a validated conversation id only from confirmed associated metadata", () => {
    const confirmation = commerce.slice(
      commerce.indexOf("export const getCommerceOrderConfirmation"),
      commerce.indexOf("const checkoutAttributionSchema"),
    );

    expect(confirmation).toContain('.select("id,status,metadata")');
    expect(confirmation).toContain('.select("status,metadata")');
    expect(confirmation).toContain('state === "confirmed"');
    expect(confirmation).toContain('metadata?.commerce_intent === "priority_dm_followup"');
    expect(confirmation).toContain("uuidSchema.safeParse(metadata?.priority_dm_request_id)");
    expect(confirmation).toContain("priorityDmRequestId");
  });

  it("repairs message notifications without expecting generic creator-sale email", () => {
    const reconciliation = fulfillment.slice(
      fulfillment.indexOf("export async function reconcileCommerceFulfillment"),
    );

    expect(reconciliation).toContain("commerce_priority_dm_messages");
    expect(reconciliation).toContain("priorityDmMessageId");
    expect(email).toContain("export async function reconcilePriorityDmNotifications");
    expect(email).toContain("enqueuePriorityDmMessageToCreatorEmail");
    expect(email).toContain("enqueuePriorityDmMessageToBuyerEmail");
    expect(server).toContain("await reconcilePriorityDmNotifications()");
  });
});
