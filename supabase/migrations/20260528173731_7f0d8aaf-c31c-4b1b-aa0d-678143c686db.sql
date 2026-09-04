
-- Avatars bucket (public read)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

create policy "avatars_owner_insert" on storage.objects
  for insert with check (
    bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "avatars_owner_update" on storage.objects
  for update using (
    bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "avatars_owner_delete" on storage.objects
  for delete using (
    bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow anonymous + authenticated visitors to insert into analytics tables via a SECURITY DEFINER function
create or replace function public.track_event(
  _kind text,
  _user_id uuid,
  _block_id uuid default null,
  _visitor_hash text default null,
  _referrer text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if _kind = 'view' then
    insert into public.profile_views(user_id, visitor_hash, referrer)
    values (_user_id, _visitor_hash, _referrer);
  elsif _kind = 'click' and _block_id is not null then
    insert into public.block_clicks(user_id, block_id, visitor_hash)
    values (_user_id, _block_id, _visitor_hash);
  end if;
end $$;

revoke execute on function public.track_event(text, uuid, uuid, text, text) from public;
grant execute on function public.track_event(text, uuid, uuid, text, text) to anon, authenticated;
