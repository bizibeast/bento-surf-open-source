-- Public-edition installation setting. Keep database entitlements aligned with
-- BENTO_EDITION=self_hosted without creating hosted subscriptions or plan grants.
insert into public.bento_instance_settings (singleton, edition)
values (true, 'self_hosted')
on conflict (singleton) do update set edition = excluded.edition;
