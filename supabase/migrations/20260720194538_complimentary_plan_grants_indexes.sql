create index complimentary_plan_grants_granted_by_idx
  on public.complimentary_plan_grants (granted_by)
  where granted_by is not null;
