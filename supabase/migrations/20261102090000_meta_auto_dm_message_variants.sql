alter table public.instagram_dm_automations
  add column reply_messages text[] not null default '{}',
  add column opening_messages text[] not null default '{}',
  add column email_prompt_messages text[] not null default '{}',
  add column follow_prompt_messages text[] not null default '{}';

alter table public.facebook_dm_automations
  add column reply_messages text[] not null default '{}',
  add column opening_messages text[] not null default '{}',
  add column email_prompt_messages text[] not null default '{}';

alter table public.instagram_dm_automations
  add constraint instagram_dm_message_variants_count check (
    cardinality(reply_messages) <= 3 and cardinality(opening_messages) <= 3
    and cardinality(email_prompt_messages) <= 3 and cardinality(follow_prompt_messages) <= 3
  );

alter table public.facebook_dm_automations
  add constraint facebook_dm_message_variants_count check (
    cardinality(reply_messages) <= 3 and cardinality(opening_messages) <= 3
    and cardinality(email_prompt_messages) <= 3
  );
