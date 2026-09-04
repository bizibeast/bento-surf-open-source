alter table public.newsletter_publications
  drop constraint if exists newsletter_publications_default_template_id_check,
  add constraint newsletter_publications_default_template_id_check
    check (default_template_id in (
      'editorial',
      'minimal',
      'bold-digest',
      'product-launch',
      'personal-note',
      'weekly-roundup',
      'visual-story',
      'event-brief',
      'resource-guide',
      'creator-notes'
    ));

alter table public.audience_campaigns
  drop constraint if exists audience_campaigns_template_id_check,
  add constraint audience_campaigns_template_id_check
    check (template_id is null or template_id in (
      'editorial',
      'minimal',
      'bold-digest',
      'product-launch',
      'personal-note',
      'weekly-roundup',
      'visual-story',
      'event-brief',
      'resource-guide',
      'creator-notes'
    ));
