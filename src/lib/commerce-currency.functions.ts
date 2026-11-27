import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { COMMERCE_CURRENCIES } from "./commerce-currency";

const currencySchema = z.enum(COMMERCE_CURRENCIES);
const updateCurrencySchema = z.object({ currency: currencySchema }).strict();

export const getMyCommerceCurrency = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("profiles")
      .select("commerce_default_currency")
      .eq("id", context.userId)
      .single();
    if (error || !data) throw new Error("Default currency could not be loaded.");
    return { currency: currencySchema.parse(data.commerce_default_currency) };
  });

export const setMyCommerceCurrency = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => updateCurrencySchema.parse(input))
  .handler(async ({ data: input, context }) => {
    const { data, error } = await context.supabase
      .from("profiles")
      .update({ commerce_default_currency: input.currency })
      .eq("id", context.userId)
      .select("commerce_default_currency")
      .single();
    if (error || !data) throw new Error("Default currency could not be saved. Try again.");
    return { currency: currencySchema.parse(data.commerce_default_currency) };
  });
