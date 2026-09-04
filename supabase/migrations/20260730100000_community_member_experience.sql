-- Complete the private community experience without exposing member content
-- through the public or authenticated Supabase APIs. Every member operation is
-- performed by the application service role after validating a hashed access
-- capability.

alter table public.commerce_access_grants
  add column if not exists community_role text not null default 'member'
    check (community_role in ('member', 'moderator')),
  add column if not exists community_notifications_enabled boolean not null default true,
  add column if not exists community_last_read_at timestamptz;

alter table public.commerce_community_posts
  add column if not exists resources jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(resources) = 'array'
      and jsonb_array_length(resources) <= 5
    ),
  add column if not exists moderation_status text not null default 'published'
    check (moderation_status in ('published', 'hidden', 'removed')),
  add column if not exists moderation_reason text,
  add column if not exists moderated_at timestamptz,
  add column if not exists moderated_by uuid references auth.users(id) on delete set null;

alter table public.commerce_community_comments
  add column if not exists parent_comment_id uuid
    references public.commerce_community_comments(id) on delete cascade,
  add column if not exists moderation_status text not null default 'published'
    check (moderation_status in ('published', 'hidden', 'removed')),
  add column if not exists moderation_reason text,
  add column if not exists moderated_at timestamptz,
  add column if not exists moderated_by uuid references auth.users(id) on delete set null;

create index if not exists commerce_community_posts_visible_idx
  on public.commerce_community_posts(product_id, moderation_status, is_pinned desc, created_at desc);

create index if not exists commerce_community_comments_visible_idx
  on public.commerce_community_comments(post_id, moderation_status, created_at);

create table if not exists public.commerce_community_notifications (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.commerce_products(id) on delete cascade,
  creator_id uuid not null references auth.users(id) on delete cascade,
  access_grant_id uuid not null references public.commerce_access_grants(id) on delete cascade,
  post_id uuid references public.commerce_community_posts(id) on delete cascade,
  comment_id uuid references public.commerce_community_comments(id) on delete cascade,
  kind text not null check (kind in ('creator_post', 'comment', 'reply', 'moderation')),
  title text not null check (length(title) between 1 and 160),
  body text not null default '' check (length(body) <= 500),
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists commerce_community_notifications_member_idx
  on public.commerce_community_notifications(access_grant_id, is_read, created_at desc);

alter table public.commerce_community_notifications enable row level security;

revoke all on public.commerce_community_notifications from anon, authenticated;
grant all on public.commerce_community_notifications to service_role;

comment on column public.commerce_access_grants.community_role is
  'Community role for this grant. The product creator is always the implicit owner.';
comment on column public.commerce_community_posts.resources is
  'Up to five validated HTTPS resources attached to a community post.';
comment on table public.commerce_community_notifications is
  'Private member notifications read through a validated Bento access capability.';
