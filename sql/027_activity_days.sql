-- One row per calendar day a student did anything that earns XP (finished a
-- lesson, unit, quiz, or the daily challenge). Drives the "activity streak"
-- and the Mon–Sun dots on the quiz-complete screen — replacing the old
-- daily-challenge-only streak (utils/achievements.getStreak).
--
-- Run in the Supabase SQL editor (dev + prod).

create table if not exists public.activity_days (
  student_id uuid not null references public.users(id) on delete cascade,
  day date not null,
  created_at timestamptz not null default now(),
  primary key (student_id, day)
);

create index if not exists activity_days_student_day_idx
  on public.activity_days (student_id, day desc);

grant all on public.activity_days to service_role;
grant all on public.activity_days to anon, authenticated;
