-- "Mistake Buster" badge — awarded the first time a student completes the
-- Daily tab's "Review Mistakes" challenge (see POST /api/daily-challenge/
-- review-complete). Previously that card promised "Badge +1" with nothing
-- behind it — this gives it a real badge to grant.
--
-- Run in the Supabase SQL editor (dev + prod).

insert into public.badges (code, label, description) values
  ('mistake_buster', 'Mistake Buster', 'Completed a mistakes review session')
on conflict (code) do nothing;
