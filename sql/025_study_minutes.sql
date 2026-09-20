-- Per-day study time. The mobile app posts elapsed foreground time while the
-- student is on a learning screen (lesson / unit / quiz / class path); this
-- table sums it. Shown on the home "Study Time" stat tile.
--
-- Run in the Supabase SQL editor (dev + prod).

create table if not exists public.study_minutes (
  student_id uuid not null references public.users(id) on delete cascade,
  day date not null,
  minutes integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (student_id, day)
);

create index if not exists study_minutes_student_idx on public.study_minutes (student_id);

grant all on public.study_minutes to service_role;
grant all on public.study_minutes to anon, authenticated;
