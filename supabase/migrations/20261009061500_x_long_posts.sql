-- X Premium accounts may publish posts of up to 25,000 characters.
alter table public.social_posts
  drop constraint if exists social_posts_body_length;

alter table public.social_posts
  add constraint social_posts_body_length check (length(body) <= 25000);
