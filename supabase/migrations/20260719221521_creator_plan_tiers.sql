-- Three-tier creator plans. Keep is_pro during the transition because existing
-- RLS policies and clients use it as the paid/unpaid compatibility flag.
alter table public.profiles
  add column if not exists plan_id text not null default 'free'
  constraint profiles_plan_id_check check (plan_id in ('free', 'pro', 'max'));

update public.profiles
set plan_id = 'pro'
where is_pro = true and plan_id = 'free';

alter table public.subscriptions
  add column if not exists plan_id text not null default 'free'
  constraint subscriptions_plan_id_check check (plan_id in ('free', 'pro', 'max'));

update public.subscriptions s
set plan_id = p.plan_id
from public.profiles p
where p.id = s.user_id and s.plan_id = 'free';

create index if not exists profiles_plan_id_idx on public.profiles (plan_id);
