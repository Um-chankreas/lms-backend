-- A point value per assignment, set by the teacher, shown to students
-- alongside their earned score (e.g. "32 / 40 pts" once graded). Distinct
-- from `grade`/`score`, which stay 0-100 percentages under the hood —
-- earned points are computed client-side as round(grade / 100 * points).
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.assignments
  add column if not exists points integer not null default 100;

do $$ begin
  alter table public.assignments
    add constraint assignments_points_check check (points > 0);
exception when duplicate_object then null; end $$;
