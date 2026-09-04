/* eslint-disable @typescript-eslint/no-explicit-any -- Payment rows are service-role only. */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { creatorPaymentProvider, type CreatorPaymentProvider } from "@/lib/payment-providers";

export function creatorPaymentAccountReady(account: any) {
  const webhookReady =
    account?.provider === "paypal" && account?.credential_mode === "api_key"
      ? Boolean(account.webhook_endpoint_id)
      : Boolean(account?.webhook_endpoint_id && account?.webhook_secret_ciphertext);
  return Boolean(
    account &&
    account.onboarding_status === "complete" &&
    account.charges_enabled &&
    account.payouts_enabled &&
    webhookReady,
  );
}

export type CreatorStorePaymentSetup = {
  ready: boolean;
  selectedProvider: CreatorPaymentProvider | null;
};

/**
 * A creator's Store is ready only when the provider selected on their profile
 * still has a complete, chargeable connection and a verified webhook. Keeping
 * this check server-side prevents product/block creation from bypassing the
 * onboarding UI with a hand-crafted request.
 */
export async function creatorStorePaymentSetup(
  creatorId: string,
): Promise<CreatorStorePaymentSetup> {
  const adminDb = supabaseAdmin as any;
  const { data: profile, error: profileError } = await adminDb
    .from("profiles")
    .select("commerce_payment_provider")
    .eq("id", creatorId)
    .single();
  if (profileError) throw new Error(profileError.message);

  const selectedProvider = creatorPaymentProvider(
    String(profile?.commerce_payment_provider || ""),
  )?.id;
  if (!selectedProvider) return { ready: false, selectedProvider: null };

  const { data: account, error: accountError } = await adminDb
    .from("creator_payment_accounts")
    .select(
      "provider, credential_mode, onboarding_status, charges_enabled, payouts_enabled, webhook_endpoint_id, webhook_secret_ciphertext",
    )
    .eq("creator_id", creatorId)
    .eq("provider", selectedProvider)
    .maybeSingle();
  if (accountError) throw new Error(accountError.message);

  return {
    ready: creatorPaymentAccountReady(account),
    selectedProvider,
  };
}

export async function requireCreatorStorePaymentSetup(creatorId: string) {
  const setup = await creatorStorePaymentSetup(creatorId);
  if (!setup.ready) {
    throw new Error(
      "Connect and select a payment gateway before creating Store products or blocks.",
    );
  }
  return setup;
}

export async function requireReadyCreatorPaymentProvider(
  creatorId: string,
  requestedProvider: CreatorPaymentProvider,
) {
  const { data: account, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select(
      "provider, credential_mode, onboarding_status, charges_enabled, payouts_enabled, webhook_endpoint_id, webhook_secret_ciphertext",
    )
    .eq("creator_id", creatorId)
    .eq("provider", requestedProvider)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!creatorPaymentAccountReady(account)) {
    const name = creatorPaymentProvider(requestedProvider)?.name || "payment gateway";
    throw new Error(
      `Finish the ${name} payment, payout, and webhook setup before publishing or selling this offer.`,
    );
  }
  return account;
}

export async function requireExclusiveCreatorPaymentProvider(
  creatorId: string,
  requestedProvider: CreatorPaymentProvider,
) {
  const { data, error } = await (supabaseAdmin as any)
    .from("creator_payment_accounts")
    .select("provider")
    .eq("creator_id", creatorId)
    .neq("provider", requestedProvider)
    .limit(1);

  if (error) throw new Error(error.message);
  const connectedProvider = data?.[0]?.provider as CreatorPaymentProvider | undefined;
  if (!connectedProvider) return;

  const connectedName =
    creatorPaymentProvider(connectedProvider)?.name || "your current payment gateway";
  throw new Error(
    `Only one payment gateway can be connected at a time. Disconnect ${connectedName} before connecting another provider.`,
  );
}
