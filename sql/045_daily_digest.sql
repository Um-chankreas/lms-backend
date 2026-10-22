-- Replaces the noisy per-quiz "X took a quiz" / "X beat your score" alerts
-- (removed from src/utils/notifyEvents.js) with one evening digest per day:
--   - "Today's most active" shout-out to every student, and
--   - a "come learn" nudge to every student who did nothing today.
-- See src/utils/dailyDigest.js + dailyDigestScheduler.js.
--
-- One row per calendar day the digest job has already run for — the same
-- "insert wins the claim" pattern as sql/039's class_schedule_notifications,
-- so a job tick that fires after the digest already ran today is a no-op
-- instead of re-sending to everyone.
--
-- Run in the Supabase SQL editor (prod; dev too if you want to test there).

create table if not exists public.daily_digest_log (
  day date primary key,
  champion_student_id uuid references public.users(id),
  champion_count integer,
  sent_at timestamptz not null default now()
);

grant all on public.daily_digest_log to service_role;
