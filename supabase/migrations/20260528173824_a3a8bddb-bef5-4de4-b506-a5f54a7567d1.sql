revoke execute on function public.track_event(text, uuid, uuid, text, text) from anon, authenticated;
grant execute on function public.track_event(text, uuid, uuid, text, text) to service_role;