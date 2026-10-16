begin;
-- Validate the persisted agent media policy at scheduling and target dispatch.
-- Keep the scheduler's atomic save implementation and publishing behavior intact.
create function public.enforce_content_agent_publish_media() returns trigger
language plpgsql security invoker set search_path='' as $$
declare post public.social_posts%rowtype; provider text;
begin
 if tg_table_name='social_posts' then
   post:=new; provider:=post.settings->>'platform';
 else
   select * into post from public.social_posts where id=new.post_id;
   provider:=new.provider;
 end if;
 if post.status not in ('scheduled','publishing') or not (post.settings ? 'card') then return new; end if;
 if (provider='linkedin' or (provider='twitter' and post.settings#>>'{agentDraftState,photoRequired}'='true'))
   and not exists(select 1 from jsonb_array_elements(coalesce(post.media,'[]')) m where m->>'mimeType' in ('image/jpeg','image/png','image/webp'))
 then raise exception 'This agent post needs a photo before publishing.'; end if;
 if provider='instagram' and (coalesce(jsonb_array_length(post.media),0) not between 2 and 10
   or exists(select 1 from jsonb_array_elements(post.media) m where m->>'mimeType' is distinct from 'image/jpeg'))
 then raise exception 'Instagram agent posts need a complete carousel of 2-10 JPEG slides.'; end if;
 return new;
end; $$;
revoke all on function public.enforce_content_agent_publish_media() from public,anon,authenticated;
grant execute on function public.enforce_content_agent_publish_media() to service_role;
create trigger content_agent_post_media_guard before update of status,media on public.social_posts
 for each row execute function public.enforce_content_agent_publish_media();
create trigger content_agent_target_media_guard before insert or update of provider,status on public.social_post_targets
 for each row execute function public.enforce_content_agent_publish_media();
commit;
