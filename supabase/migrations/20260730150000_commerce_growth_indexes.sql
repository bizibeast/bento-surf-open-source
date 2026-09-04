-- Cover the remaining creator-growth foreign keys so deletes and joins do not
-- degrade as campaigns, lists, order bumps, and email delivery history grow.

create index if not exists commerce_order_bumps_bump_product_idx
  on public.commerce_order_bumps(bump_product_id);

create index if not exists audience_campaigns_list_idx
  on public.audience_campaigns(list_id);

create index if not exists audience_campaign_recipients_contact_idx
  on public.audience_campaign_recipients(contact_id);

create index if not exists audience_campaign_recipients_outbox_idx
  on public.audience_campaign_recipients(email_outbox_id)
  where email_outbox_id is not null;
