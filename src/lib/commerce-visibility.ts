/** Unlisted sessions remain published and bookable through their direct link. */
export function isCommerceProductListed(product: { kind: string; settings?: unknown }) {
  if (product.kind !== "coaching_call") return true;
  const settings = product.settings;
  return !(
    settings &&
    typeof settings === "object" &&
    "calendarVisibility" in settings &&
    settings.calendarVisibility === "unlisted"
  );
}
