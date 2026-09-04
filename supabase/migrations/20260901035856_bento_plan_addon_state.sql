alter table public.subscriptions
  add column if not exists contact_tier_contacts integer not null default 500,
  add column if not exists storage_addon_units integer not null default 0,
  add constraint subscriptions_contact_tier_contacts_check
    check (contact_tier_contacts in (500, 5000, 10000, 25000, 50000, 100000, 150000)),
  add constraint subscriptions_storage_addon_units_check
    check (storage_addon_units between 0 and 100);
