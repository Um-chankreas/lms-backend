-- Skip tests ("test out", Duolingo-style): after a good practice score a
-- student can skip the next two units by passing a 3-question hard test, or
-- skip a whole chapter by passing a 5-question hard test drawn from it.
--
-- Each attempt remembers exactly which questions it served, so grading cannot
-- be dodged by only answering the easy ones.
--
-- Run in the Supabase SQL editor (dev and prod).

create table if not exists public.skip_test_attempts (
  id uuid primary key,
  student_id uuid not null references public.users(id) on delete cascade,
  scope text not null check (scope in ('units', 'chapter')),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  unit_ids uuid[] not null default '{}',      -- the units this test would skip
  question_ids uuid[] not null default '{}',  -- the questions served
  max_mistakes integer not null,              -- pass if mistakes <= this
  score integer,
  passed boolean,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);

create index if not exists skip_test_attempts_student_idx
  on public.skip_test_attempts (student_id, created_at desc);
