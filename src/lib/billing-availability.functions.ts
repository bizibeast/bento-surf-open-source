import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { resolveBillingProduct } from "./billing-catalog";
import { FULLY_MANAGED_BILLING_CATALOG, FULLY_MANAGED_DODO_PRODUCT_ENV } from "./plans";

export const fullyManagedCheckoutAvailable = createServerOnlyFn(
  () =>
    process.env.BENTO_EDITION !== "self_hosted" &&
    process.env.BENTO_FULLY_MANAGED_CHECKOUT_ENABLED === "true" &&
    resolveBillingProduct(process.env[FULLY_MANAGED_DODO_PRODUCT_ENV]?.trim(), process.env)
      ?.catalog === FULLY_MANAGED_BILLING_CATALOG,
);

export const getFullyManagedCheckoutAvailability = createServerFn({ method: "GET" }).handler(() =>
  fullyManagedCheckoutAvailable(),
);
