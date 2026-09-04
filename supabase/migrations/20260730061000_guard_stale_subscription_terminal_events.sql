-- Provider webhooks can arrive out of order. Prevent a terminal event from an
-- older billing period from revoking access already extended by a newer paid
-- renewal. This is a follow-up migration because the base lifecycle migration
-- was already validated and applied to staging.

create or replace function public.apply_commerce_subscription_lifecycle(
  p_provider text,
  p_provider_account_id text,
  p_provider_subscription_id text,
  p_state text,
  p_provider_event_id text,
  p_current_period_start timestamptz default null,
  p_current_period_end timestamptz default null,
  p_cancel_at_period_end boolean default false,
  p_metadata jsonb default '{}'::jsonb,
  p_grace_days integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  subscription_row public.commerce_subscription_access%rowtype;
  paid_order public.commerce_orders%rowtype;
  durable_grant public.commerce_access_grants%rowtype;
  normalized_state text;
  effective_state text;
  effective_period_start timestamptz;
  effective_period_end timestamptz;
  effective_grace timestamptz;
  access_deadline timestamptz;
begin
  if coalesce(trim(p_provider), '') = ''
    or coalesce(trim(p_provider_subscription_id), '') = '' then
    raise exception 'Provider and subscription id are required';
  end if;
  if p_state not in ('active', 'renewed', 'cancel_at_period_end', 'past_due', 'expired', 'revoked') then
    raise exception 'Unsupported subscription lifecycle state';
  end if;
  if p_grace_days < 0 or p_grace_days > 30 then
    raise exception 'Subscription grace period is invalid';
  end if;

  normalized_state := case
    when p_state = 'renewed' then 'active'
    else p_state
  end;

  select *
    into paid_order
    from public.commerce_orders
   where provider = p_provider
     and coalesce(provider_account_id, '') = coalesce(p_provider_account_id, '')
     and provider_subscription_id = p_provider_subscription_id
     and status = 'paid'
   order by paid_at desc nulls last, created_at desc
   limit 1;

  if paid_order.id is null then
    return jsonb_build_object('applied', false, 'reason', 'paid_order_not_found');
  end if;

  select *
    into subscription_row
    from public.commerce_subscription_access
   where provider = p_provider
     and provider_account_id = coalesce(p_provider_account_id, '')
     and provider_subscription_id = p_provider_subscription_id
   for update;

  if subscription_row.id is not null
    and p_provider_event_id is not null
    and subscription_row.last_provider_event_id = p_provider_event_id then
    return jsonb_build_object(
      'applied', false,
      'reason', 'already_processed',
      'subscription_access_id', subscription_row.id
    );
  end if;

  if subscription_row.id is not null
    and normalized_state in ('expired', 'revoked')
    and p_current_period_end is not null
    and subscription_row.current_period_end is not null
    and p_current_period_end < subscription_row.current_period_end then
    return jsonb_build_object(
      'applied', false,
      'reason', 'stale_terminal_event',
      'subscription_access_id', subscription_row.id,
      'access_grant_id', subscription_row.access_grant_id,
      'status', subscription_row.status
    );
  end if;

  if subscription_row.access_grant_id is not null then
    select * into durable_grant
      from public.commerce_access_grants
     where id = subscription_row.access_grant_id
     for update;
  end if;

  if durable_grant.id is null then
    select grant_row.*
      into durable_grant
      from public.commerce_access_grants grant_row
      join public.commerce_orders order_row on order_row.id = grant_row.order_id
     where order_row.provider = p_provider
       and coalesce(order_row.provider_account_id, '') = coalesce(p_provider_account_id, '')
       and order_row.provider_subscription_id = p_provider_subscription_id
     order by grant_row.created_at asc
     limit 1
     for update of grant_row;
  end if;

  effective_period_start := coalesce(
    p_current_period_start,
    subscription_row.current_period_start
  );
  effective_period_end := coalesce(
    p_current_period_end,
    subscription_row.current_period_end
  );

  if subscription_row.current_period_end is not null
    and effective_period_end is not null
    and effective_period_end < subscription_row.current_period_end
    and normalized_state in ('active', 'past_due', 'cancel_at_period_end') then
    effective_period_end := subscription_row.current_period_end;
    effective_period_start := subscription_row.current_period_start;
  end if;

  effective_state := normalized_state;
  effective_grace := null;
  access_deadline := null;

  if normalized_state = 'active' then
    if effective_period_end is not null then
      effective_grace := effective_period_end + make_interval(days => p_grace_days);
      access_deadline := effective_grace;
    end if;
  elsif normalized_state = 'cancel_at_period_end' then
    access_deadline := effective_period_end;
  elsif normalized_state = 'past_due' then
    effective_grace := greatest(
      coalesce(effective_period_end, now()),
      now()
    ) + make_interval(days => p_grace_days);
    access_deadline := effective_grace;
  elsif normalized_state in ('expired', 'revoked') then
    access_deadline := now();
  end if;

  insert into public.commerce_subscription_access(
    provider,
    provider_account_id,
    provider_subscription_id,
    product_id,
    creator_id,
    buyer_email,
    access_grant_id,
    status,
    current_period_start,
    current_period_end,
    grace_expires_at,
    cancel_at_period_end,
    last_provider_event_id,
    metadata
  ) values (
    p_provider,
    coalesce(p_provider_account_id, ''),
    p_provider_subscription_id,
    paid_order.product_id,
    paid_order.creator_id,
    lower(paid_order.buyer_email),
    durable_grant.id,
    effective_state,
    effective_period_start,
    effective_period_end,
    effective_grace,
    p_cancel_at_period_end or effective_state = 'cancel_at_period_end',
    p_provider_event_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (provider, provider_account_id, provider_subscription_id)
  do update set
    product_id = excluded.product_id,
    creator_id = excluded.creator_id,
    buyer_email = excluded.buyer_email,
    access_grant_id = coalesce(
      public.commerce_subscription_access.access_grant_id,
      excluded.access_grant_id
    ),
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    grace_expires_at = excluded.grace_expires_at,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_provider_event_id = excluded.last_provider_event_id,
    metadata = public.commerce_subscription_access.metadata || excluded.metadata
  returning * into subscription_row;

  if durable_grant.id is not null then
    if effective_state in ('expired', 'revoked') then
      update public.commerce_access_grants
         set status = case when effective_state = 'revoked'
           then 'revoked'::public.commerce_access_status
           else 'expired'::public.commerce_access_status
         end,
             expires_at = access_deadline
       where id = durable_grant.id;
    else
      update public.commerce_access_grants
         set status = 'active',
             expires_at = access_deadline
       where id = durable_grant.id;
    end if;
  end if;

  return jsonb_build_object(
    'applied', true,
    'subscription_access_id', subscription_row.id,
    'access_grant_id', subscription_row.access_grant_id,
    'status', subscription_row.status,
    'access_deadline', access_deadline
  );
end;
$$;

revoke all on function public.apply_commerce_subscription_lifecycle(
  text, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.apply_commerce_subscription_lifecycle(
  text, text, text, text, text, timestamptz, timestamptz, boolean, jsonb, integer
) to service_role;
