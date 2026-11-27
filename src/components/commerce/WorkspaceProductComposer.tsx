import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getMyCommerce } from "@/lib/commerce.functions";
import { getMyProfile } from "@/lib/profile.functions";
import { getMyCommerceCurrency } from "@/lib/commerce-currency.functions";
import {
  commerceDefaultCurrencyQueryKey,
  DEFAULT_COMMERCE_CURRENCY,
} from "@/lib/commerce-currency";
import { getBookingAvailabilityDefaults } from "@/lib/booking.functions";
import {
  isCommerceOfferKind,
  type CommerceProductKind,
  type CommerceProductRecord,
} from "@/lib/commerce";
import { ProductBuilder } from "./ProductBuilder";

export type WorkspaceProductComposerProps = {
  kind: CommerceProductKind;
  productId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (product: CommerceProductRecord) => void | Promise<void>;
};

/** One product editor and data contract, wherever a creator manages the offer. */
export function WorkspaceProductComposer(props: WorkspaceProductComposerProps) {
  const { kind, productId, open, onOpenChange, onSaved } = props;
  const queryClient = useQueryClient();
  const commerce = useQuery({
    queryKey: ["my-commerce"],
    queryFn: () => getMyCommerce(),
    enabled: open,
  });
  const profile = useQuery({
    queryKey: ["my-profile"],
    queryFn: () => getMyProfile(),
    enabled: open,
  });
  const currency = useQuery({
    queryKey: commerceDefaultCurrencyQueryKey,
    queryFn: () => getMyCommerceCurrency(),
    enabled: open && !productId,
  });
  const booking = useQuery({
    queryKey: ["booking-availability-defaults"],
    queryFn: () => getBookingAvailabilityDefaults(),
    enabled: open && kind === "coaching_call",
  });
  if (!open) return null;
  const product = productId
    ? (commerce.data?.products.find((item: CommerceProductRecord) => item.id === productId) as
        CommerceProductRecord | undefined)
    : undefined;
  const loading =
    commerce.isPending ||
    profile.isPending ||
    (!productId && currency.isPending) ||
    (kind === "coaching_call" && booking.isPending);
  const error =
    kind === "newsletter"
      ? "Create and manage newsletters with the Newsletter publication builder."
      : (commerce.isError && commerce.data === undefined) ||
          (profile.isError && profile.data === undefined) ||
          (!productId && currency.isError && currency.data === undefined) ||
          (kind === "coaching_call" && booking.isError && booking.data === undefined)
        ? "Product details could not be loaded. Close this editor and try again."
        : !loading && commerce.data?.locked && isCommerceOfferKind(kind)
          ? "Creating and editing products requires the Store plan."
          : !loading && productId && (!product || product.kind !== kind)
            ? "Product not found in this workspace."
            : null;
  if (loading || error)
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>{error ? "Product unavailable" : "Loading product"}</DialogTitle>
          {error ? (
            <p role="alert">{error}</p>
          ) : (
            <Loader2 aria-label="Loading product" className="size-5 animate-spin" />
          )}
        </DialogContent>
      </Dialog>
    );
  return (
    <ProductBuilder
      key={`${kind}:${productId || "new"}`}
      open
      kind={kind}
      product={product}
      profile={profile.data}
      bookingAvailability={booking.data}
      products={
        (commerce.data?.products ?? []).filter((item: CommerceProductRecord) =>
          isCommerceOfferKind(item.kind),
        ) as CommerceProductRecord[]
      }
      paymentProvider={commerce.data?.storeSetup?.selectedProvider ?? null}
      defaultCurrency={currency.data?.currency ?? DEFAULT_COMMERCE_CURRENCY}
      defaultCurrencyLoading={false}
      onOpenChange={onOpenChange}
      onSaved={async (saved) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["my-commerce"] }),
          queryClient.invalidateQueries({ queryKey: ["community-workspace"] }),
          queryClient.invalidateQueries({ queryKey: ["priority-dm"] }),
          queryClient.invalidateQueries({ queryKey: ["booking-workspace"] }),
        ]);
        await onSaved?.(saved);
        onOpenChange(false);
      }}
    />
  );
}
