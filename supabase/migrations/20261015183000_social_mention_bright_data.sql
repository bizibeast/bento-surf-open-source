-- Keep interactive profile discovery within a separate, hard monthly budget.
alter table public.social_preview_budgets
  drop constraint social_preview_budgets_provider_check;
alter table public.social_preview_budgets
  add constraint social_preview_budgets_provider_check
  check (provider in ('browser_run', 'bright_data', 'mention_search'));

create table public.social_mention_search_cache (
  provider text not null,
  query text not null,
  items jsonb not null,
  expires_at timestamptz not null,
  primary key (provider, query),
  constraint social_mention_search_cache_provider_check
    check (provider in ('twitter', 'facebook', 'instagram', 'linkedin', 'threads', 'tiktok', 'youtube')),
  constraint social_mention_search_cache_query_check check (length(query) between 3 and 60),
  constraint social_mention_search_cache_items_check check (jsonb_typeof(items) = 'array')
);

alter table public.social_mention_search_cache enable row level security;
revoke all on public.social_mention_search_cache from public, anon, authenticated;
grant all on public.social_mention_search_cache to service_role;

create or replace function public.claim_social_mention_search_budget(
  p_period_start date,
  p_limit bigint
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed boolean;
begin
  if p_period_start <> date_trunc('month', now() at time zone 'UTC')::date
     or p_limit < 1 or p_limit > 3000 then
    return false;
  end if;

  insert into public.social_preview_budgets(provider, period_start, used)
  values ('mention_search', p_period_start, 1)
  on conflict (provider, period_start) do update
    set used = public.social_preview_budgets.used + 1,
        updated_at = now()
    where public.social_preview_budgets.used < p_limit
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_social_mention_search_budget(date, bigint)
  from public, anon, authenticated;
grant execute on function public.claim_social_mention_search_budget(date, bigint)
  to service_role;
