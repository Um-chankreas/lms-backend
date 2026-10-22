-- Onboarding now asks what the student wants the app for, and the home card
-- lets them test themselves chapter by chapter (3 random questions).

alter table public.bacii_profiles
  add column if not exists purposes text[] not null default '{}';

create table if not exists public.bacii_test_results (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  course_id uuid references public.courses(id) on delete set null,
  correct smallint not null,
  total smallint not null,
  created_at timestamp with time zone not null default now()
);

create index if not exists bacii_test_results_student_idx
  on public.bacii_test_results (student_id, created_at desc);
