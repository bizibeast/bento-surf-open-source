-- Topics support a grouped story index without changing the story's text or source.
alter table public.creator_brain_items add column tags text[] not null default '{}' check (cardinality(tags) <= 8);
notify pgrst, 'reload schema';
