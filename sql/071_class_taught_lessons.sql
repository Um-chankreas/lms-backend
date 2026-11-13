-- Which lessons the teacher has actually taught in class. One row = "this lesson was taught on this day".
-- It is the class's real pace: the Follow-up page compares each student's progress against it.
-- Run once per Supabase project.
create table if not exists public.class_taught_lessons (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  taught_on date not null default current_date,
  taught_by uuid references public.users(id) on delete set null,
  live_class_id uuid references public.live_classes(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (course_id, lesson_id)
);
create index if not exists class_taught_lessons_course_idx on public.class_taught_lessons (course_id, taught_on desc);

-- Only the backend (service role) reads or writes it; no direct access for app users.
alter table public.class_taught_lessons enable row level security;
grant all on public.class_taught_lessons to service_role;
