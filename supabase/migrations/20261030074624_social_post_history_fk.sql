begin;

alter table public.social_post_targets
  alter column connection_id drop not null,
  drop constraint if exists social_post_targets_connection_id_fkey;
alter table public.social_post_targets
  add constraint social_post_targets_connection_id_fkey
  foreign key (connection_id) references public.social_connections(id) on delete set null;

commit;
