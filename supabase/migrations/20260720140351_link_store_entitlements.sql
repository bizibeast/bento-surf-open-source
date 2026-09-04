-- Rename the paid tiers without changing anyone's access. is_pro remains the
-- compatibility paid/unpaid flag while application code moves to entitlements.
alter table public.profiles drop constraint if exists profiles_plan_id_check;
alter table public.subscriptions drop constraint if exists subscriptions_plan_id_check;

update public.profiles
set plan_id = case plan_id when 'max' then 'store' when 'pro' then 'link' else 'free' end;

update public.subscriptions
set plan_id = case plan_id when 'max' then 'store' when 'pro' then 'link' else 'free' end;

alter table public.profiles
  add constraint profiles_plan_id_check check (plan_id in ('free', 'link', 'store'));

alter table public.subscriptions
  add constraint subscriptions_plan_id_check check (plan_id in ('free', 'link', 'store'));

update public.profiles set is_pro = (plan_id <> 'free');
