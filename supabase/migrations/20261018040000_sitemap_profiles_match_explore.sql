-- Sitemap profiles follow the same eligibility as /explore. Unlisted creators
-- stay out of the sitemap so crawlers are not sent to pages with no inbound link.

create or replace view public.sitemap_profiles
with (security_invoker = true)
as
with home_cards as (
  select block.user_id, count(*)::integer as card_count
  from public.blocks as block
  where block.page_id is null
  group by block.user_id
)
select
  profile.id,
  profile.username,
  profile.display_name,
  profile.bio,
  profile.meta_description,
  profile.avatar_url,
  greatest(
    profile.updated_at,
    coalesce(
      (
        select max(root_block.updated_at)
        from public.blocks as root_block
        where root_block.user_id = profile.id
          and root_block.page_id is null
      ),
      profile.updated_at
    )
  ) as updated_at,
  profile.onboarded,
  profile.noindex,
  profile.plan_id,
  profile.is_pro,
  true as has_public_content
from public.profiles as profile
join home_cards on home_cards.user_id = profile.id
where profile.show_in_explore = true
  and profile.explore_review_status = 'approved'
  and profile.onboarded = true
  and profile.noindex = false
  and home_cards.card_count > 3
  and lower(profile.username) not in ('tmkc', 'yashgay')
  and char_length(btrim(profile.username)) > 0
  and char_length(btrim(coalesce(profile.display_name, ''))) > 0;

revoke all on public.sitemap_profiles from public, anon, authenticated;
grant select on public.sitemap_profiles to service_role;

notify pgrst, 'reload schema';
