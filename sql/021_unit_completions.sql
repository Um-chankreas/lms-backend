-- Per-unit read tracking, needed to gate the step-by-step learning path
-- (GET /api/courses/:id/path): one path step per unit, plus one more step
-- for that unit's quiz when it has one. See POST /api/units/:id/complete.
--
-- A chapter (lessons row) still auto-completes (lesson_completions, same as
-- before) the moment every one of its units — and every one of those units'
-- quizzes — is done; nothing else needs to change for existing features
-- that read lesson_completions (course progress %, etc).

create table if not exists public.unit_completions (
  id uuid primary key,
  unit_id uuid not null references public.lesson_units(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  completed_at timestamptz not null default now(),
  unique (unit_id, student_id)
);

create index if not exists unit_completions_student_idx on public.unit_completions (student_id);

grant all on public.unit_completions to service_role;
grant all on public.unit_completions to anon, authenticated;
