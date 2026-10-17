-- Private workspace-wide delay and a short lease for rotating OAuth tokens.
alter table public.profiles add column auto_dm_delay_seconds integer not null default 60
  check (auto_dm_delay_seconds in (30, 60, 120, 180));

alter table public.social_connections
  add column token_refresh_lease_id uuid,
  add column token_refresh_lease_until timestamptz;

create function public.claim_social_token_refresh(p_connection_id uuid, p_lease_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.social_connections
    set token_refresh_lease_id = p_lease_id,
        token_refresh_lease_until = now() + interval '180 seconds'
    where id = p_connection_id and status <> 'revoked'
      and (token_refresh_lease_until is null or token_refresh_lease_until < now());
  return found;
end;
$$;
revoke all on function public.claim_social_token_refresh(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_social_token_refresh(uuid,uuid) to service_role;
