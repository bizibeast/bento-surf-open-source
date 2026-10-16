import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Provider trial dates are accepted only against server-created checkout terms. */
export async function readTrialTerms(input: {
  workspaceId: string;
  ownerId: string | null;
  checkoutKey: string | null;
  subscriptionId: string;
}) {
  if (!input.ownerId || !input.checkoutKey) return null;
  // The generated types are updated after the migration is applied locally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any;
  const [checkout, owner] = await Promise.all([
    db
      .from("bento_trial_checkouts")
      .select("trial_days")
      .eq("auth_user_id", input.ownerId)
      .eq("workspace_id", input.workspaceId)
      .eq("checkout_key", input.checkoutKey)
      .maybeSingle(),
    db
      .from("bento_trial_owners")
      .select("workspace_id,subscription_id,trial_days,extension_approved_until")
      .eq("auth_user_id", input.ownerId)
      .maybeSingle(),
  ]);
  if (checkout.error || owner.error || !checkout.data)
    throw new Error("Trial checkout terms could not be verified.");
  const days = Number(checkout.data.trial_days);
  if (days !== 3 && days !== 7) throw new Error("Trial duration could not be verified.");
  if (
    owner.data &&
    (owner.data.workspace_id !== input.workspaceId ||
      owner.data.subscription_id !== input.subscriptionId ||
      Number(owner.data.trial_days) !== days)
  )
    throw new Error("Trial ownership could not be verified.");
  return {
    days,
    approvedExtensionEnd: (owner.data?.extension_approved_until as string | null) ?? null,
  };
}
