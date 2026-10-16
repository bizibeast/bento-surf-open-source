-- A deliberate subscription pause is distinct from a failed payment. The
-- following migration updates reconciliation and hosted access for this state.
alter type public.subscription_status add value if not exists 'paused';
