alter table public.profiles
  add column if not exists account_timezone text;

alter table public.profiles
  drop constraint if exists profiles_account_timezone_length;
alter table public.profiles
  add constraint profiles_account_timezone_length check (
    account_timezone is null
    or char_length(account_timezone) between 1 and 100
  );

grant select (account_timezone) on public.profiles to authenticated;

create or replace function public.set_creator_account_timezone(
  p_manual_timezone text,
  p_detected_timezone text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid := (select auth.uid());
  effective_timezone text;
begin
  if v_creator_id is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_timezone_names
    where name = p_detected_timezone
  ) then
    raise exception 'Choose a valid detected timezone.';
  end if;

  if p_manual_timezone is not null and not exists (
    select 1
    from pg_catalog.pg_timezone_names
    where name = p_manual_timezone
  ) then
    raise exception 'Choose a valid account timezone.';
  end if;

  effective_timezone := coalesce(p_manual_timezone, p_detected_timezone);

  update public.profiles
  set account_timezone = p_manual_timezone,
      analytics_timezone = effective_timezone,
      updated_at = now()
  where id = v_creator_id;

  update public.booking_availability
  set timezone = effective_timezone,
      updated_at = now()
  where booking_availability.creator_id = v_creator_id;

  update public.commerce_products
  set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb),
        '{timezone}',
        to_jsonb(effective_timezone),
        true
      ),
      updated_at = now()
  where commerce_products.creator_id = v_creator_id
    and kind in ('coaching_call', 'webinar');

  update public.social_posts
  set timezone = effective_timezone,
      updated_at = now()
  where user_id = v_creator_id
    and status in ('draft', 'scheduled');

  update public.commerce_bookings
  set timezone = effective_timezone,
      updated_at = now()
  where commerce_bookings.creator_id = v_creator_id
    and starts_at >= now()
    and status = 'confirmed';

  return effective_timezone;
end;
$$;

revoke all on function public.set_creator_account_timezone(text, text) from public;
revoke all on function public.set_creator_account_timezone(text, text) from anon;
grant execute on function public.set_creator_account_timezone(text, text) to authenticated;

notify pgrst, 'reload schema';
