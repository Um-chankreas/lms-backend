-- MCQ-style assignments: a teacher-authored, course-level, deadline-bound
-- quiz. `assignments.type` discriminates the two submission shapes:
--   'file' (default) — original flow, unchanged: submission_text / file_url,
--                       teacher hand-grades via PUT .../submissions/:id/grade
--   'quiz'            — new flow: assignment_questions (MCQ only),
--                       auto-graded into answers/score on submit
--
-- `assignments` / `assignment_submissions` themselves predate migration
-- tracking (created ad hoc in Supabase) — everything here is defensive.
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.assignments
  add column if not exists type text not null default 'file';

do $$ begin
  alter table public.assignments
    add constraint assignments_type_check check (type in ('file', 'quiz'));
exception when duplicate_object then null; end $$;

create table if not exists public.assignment_questions (
  id uuid primary key,
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  question text not null,
  options jsonb not null default '[]'::jsonb,
  correct_answer text,
  explanation text,
  question_type text not null default 'QCM',
  order_number integer not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists assignment_questions_assignment_id_idx
  on public.assignment_questions (assignment_id);

-- Quiz-type grading result — nullable, populated only for type='quiz'
-- submissions. Score only (no pass/fail column, per product decision).
alter table public.assignment_submissions
  add column if not exists answers jsonb,
  add column if not exists score integer;

grant all on public.assignment_questions to service_role;
grant all on public.assignment_questions to anon, authenticated;
