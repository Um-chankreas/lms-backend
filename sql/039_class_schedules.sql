-- Recurring weekly schedule for a course's live classes (e.g. "every Mon
-- and Wed, 3:00-4:30 PM"), so students can be reminded shortly before each
-- session — independent of the one-off live_classes rows a teacher creates
-- per session (see sql/006_live_classes.sql). A course can have several
-- slots (e.g. Mon/Wed AND a separate Sat session at a different time), so
-- this is one row per slot, not one row per course.
--
-- days_of_week uses JS `Date#getDay()` convention (0=Sun .. 6=Sat) to match
-- how the rest of the backend computes "today" (see src/utils/streak.js,
-- dashboard.routes.js) and so the cron job in src/utils/classScheduler.js
-- can test membership with `schedule.days_of_week.includes(new Date().getDay())`
-- with no conversion.
--
-- Run in the Supabase SQL editor (dev + prod).

create table if not exists public.class_schedules (
  id uuid primary key,
  course_id uuid not null references public.courses(id) on delete cascade,
  teacher_id uuid not null references public.users(id),
  days_of_week smallint[] not null,
  start_time time not null,
  end_time time not null,
  timezone text not null default 'Asia/Phnom_Penh',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint class_schedules_days_not_empty check (array_length(days_of_week, 1) > 0),
  constraint class_schedules_days_valid check (days_of_week <@ array[0,1,2,3,4,5,6]::smallint[]),
  constraint class_schedules_time_order check (start_time < end_time)
);

create index if not exists class_schedules_course_idx on public.class_schedules(course_id);
create index if not exists class_schedules_active_idx on public.class_schedules(is_active);

-- Only the backend (service_role) touches this table (see
-- src/routes/classSchedule.routes.js / src/utils/classScheduler.js).
-- Explicit grant because this project has hit cases where a table created
-- outside the Supabase dashboard's own SQL editor role doesn't inherit the
-- default service_role privileges automatically (see 038's same note).
grant all on public.class_schedules to service_role;

-- One row per (schedule, calendar date) it fired for, so the reminder cron
-- (running every 1-5 min) can tell "already notified for today's 3pm slot"
-- from "haven't yet" without re-sending on every tick inside the 10-15 min
-- window. occurrence_date is the LOCAL date (in the schedule's timezone) of
-- the session being reminded about, not the date the job happened to run.
create table if not exists public.class_schedule_notifications (
  id uuid primary key,
  schedule_id uuid not null references public.class_schedules(id) on delete cascade,
  occurrence_date date not null,
  sent_at timestamptz not null default now(),
  unique (schedule_id, occurrence_date)
);

grant all on public.class_schedule_notifications to service_role;
