alter table public.profiles
  add column if not exists booking_onboarded_at timestamptz;

comment on column public.profiles.booking_onboarded_at is
  'Set once when the creator completes Bookings setup. Keeps later calendar page deletion intentional.';

notify pgrst, 'reload schema';
