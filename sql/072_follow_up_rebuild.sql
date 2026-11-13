-- Follow-up page rebuild: per-subject metrics, first-week onboarding facts and a richer follow-up log.
-- Run once per Supabase project, AFTER 069_student_followups.sql.
-- The backend (service role) computes and reads all of it; app users never touch these tables.

-- 1. One row per student x subject (course), covering the last 14 days. Refreshed hourly by the backend.
create table if not exists public.student_subject_metrics (
  student_id uuid not null references public.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  classes_held int not null default 0,
  classes_joined int not null default 0,
  live_minutes int not null default 0,
  live_hours_held numeric(6,1) not null default 0,
  studied_after_ratio numeric(4,3),            -- null when the student joined no class
  progress_pct int not null default 0,
  class_pace_pct int,                           -- null when unknown
  class_pace_source text,                       -- 'teacher' (lessons marked taught) or 'median'
  days_since_new_lesson int,
  assignments_past_due_missing int not null default 0,
  assignments_failed int not null default 0,
  computed_at timestamptz not null default now(),
  primary key (student_id, course_id)
);
create index if not exists student_subject_metrics_course_idx on public.student_subject_metrics (course_id);

-- 2. First-week facts per student. Each date is null until it happened.
create table if not exists public.student_onboarding (
  student_id uuid primary key references public.users(id) on delete cascade,
  joined_at timestamptz not null,
  tour_done_at timestamptz,
  first_lesson_at timestamptz,
  telegram_linked_at timestamptz,
  first_quiz_at timestamptz,
  first_live_at timestamptz,
  live_held_since_join int not null default 0,  -- live classes held since they joined
  active_days_count int not null default 0,
  computed_at timestamptz not null default now()
);

-- 3. The follow-up log gets the case, the reason and how the student was reached.
alter table public.student_followups
  add column if not exists course_id uuid references public.courses(id) on delete set null,
  add column if not exists case_code text check (case_code in ('0','1','2','3','4','praise')),
  add column if not exists reason text check (reason in ('time_clash','not_interested','no_internet_device','too_hard','family_work','sick','other','checked_in')),
  add column if not exists channel text check (channel in ('telegram','call','sms')),
  add column if not exists contacted_by uuid references public.users(id) on delete set null;
create index if not exists student_followups_reason_idx on public.student_followups (created_at desc) where reason is not null;

-- Only teachers and admins (through the backend) can reach them.
alter table public.student_subject_metrics enable row level security;
alter table public.student_onboarding enable row level security;
alter table public.student_followups enable row level security;
grant all on public.student_subject_metrics to service_role;
grant all on public.student_onboarding to service_role;
grant all on public.student_followups to service_role;
