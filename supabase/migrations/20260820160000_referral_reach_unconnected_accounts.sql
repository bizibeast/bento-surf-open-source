alter table public.referral_reach_submissions
  drop constraint if exists referral_reach_submissions_connection_id_fkey;

alter table public.referral_reach_submissions
  alter column connection_id drop not null;

alter table public.referral_reach_submissions
  add constraint referral_reach_submissions_connection_id_fkey
  foreign key (connection_id)
  references public.social_connections(id)
  on delete set null;
