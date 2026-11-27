import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  COMMERCE_CURRENCIES,
  COMMERCE_CURRENCY_LABELS,
  DEFAULT_COMMERCE_CURRENCY,
  commerceDefaultCurrencyQueryKey,
  type CommerceCurrency,
} from "@/lib/commerce-currency";
import { getMyCommerceCurrency, setMyCommerceCurrency } from "@/lib/commerce-currency.functions";

export function DefaultCurrencySelector() {
  const id = useId();
  const queryClient = useQueryClient();
  const currencyQuery = useQuery({
    queryKey: commerceDefaultCurrencyQueryKey,
    queryFn: () => getMyCommerceCurrency(),
  });
  const save = useMutation({
    mutationFn: (currency: CommerceCurrency) => setMyCommerceCurrency({ data: { currency } }),
    onSuccess: (result) => queryClient.setQueryData(commerceDefaultCurrencyQueryKey, result),
  });

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-[#17213a]/65">
        Default currency
      </label>
      <select
        id={id}
        value={currencyQuery.data?.currency ?? DEFAULT_COMMERCE_CURRENCY}
        disabled={!currencyQuery.data || save.isPending}
        onChange={(event) => save.mutate(event.target.value as CommerceCurrency)}
        aria-describedby={`${id}-help`}
        className="h-10 w-full rounded-xl border border-[#17213a]/10 bg-white px-3 text-sm text-[#17213a] disabled:opacity-60 sm:w-auto"
      >
        {COMMERCE_CURRENCIES.map((currency) => (
          <option key={currency} value={currency}>
            {COMMERCE_CURRENCY_LABELS[currency]}
          </option>
        ))}
      </select>
      <p id={`${id}-help`} className="text-xs text-[#17213a]/55">
        For new products. You can change the currency on each product.
      </p>
      {currencyQuery.isError ? (
        <p role="alert" className="text-xs text-rose-700">
          Default currency could not load.{" "}
          <button type="button" className="underline" onClick={() => void currencyQuery.refetch()}>
            Try again
          </button>
        </p>
      ) : save.isError ? (
        <p role="alert" className="text-xs text-rose-700">
          Default currency could not be saved. Try again.
        </p>
      ) : (
        <p role="status" className="text-xs text-[#17213a]/55">
          {save.isPending
            ? "Saving…"
            : save.isSuccess
              ? "Saved"
              : currencyQuery.isPending
                ? "Loading…"
                : ""}
        </p>
      )}
    </div>
  );
}
