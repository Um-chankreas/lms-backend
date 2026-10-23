-- Notification System v2: what the nudge engine needs to remember.
--
--  * notifications: which template/variant was sent (5-day rotation), whether it
--    was a teacher/class message or an automatic nudge (daily cap), whether a
--    push went out (bell-only rows don't count against the cap), when the
--    student opened it (back-off rule) and whether they studied within 2 hours
--    (did the nudge work?).
--  * users.language: 'km' (default) or 'en' — which copy the student receives.
--  * notification_job_log: "insert wins the claim" for the scheduled jobs, so a
--    restart or a second tick never sends the same job twice
--    (same pattern as 039's class_schedule_notifications).
--
-- Run in the Supabase SQL editor (dev + prod). The backend still works if this
-- has not been run yet — it falls back to the old columns — but rotation, the
-- daily cap and Khmer copy need it.

alter table public.notifications
  add column if not exists template_key text,
  add column if not exists variant_id text,
  add column if not exists kind text not null default 'class',
  add column if not exists push_sent boolean not null default true,
  add column if not exists opened_at timestamptz,
  add column if not exists success boolean;

alter table public.notifications
  drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (kind in ('class', 'nudge'));

-- Rotation / cap / back-off all look at a student's recent nudges.
create index if not exists notifications_user_kind_created_idx
  on public.notifications (user_id, kind, created_at desc);
-- The outcome job scans nudges whose result isn't known yet.
create index if not exists notifications_nudge_pending_idx
  on public.notifications (created_at) where kind = 'nudge' and success is null;

alter table public.users
  add column if not exists language text not null default 'km';
alter table public.users
  drop constraint if exists users_language_check;
alter table public.users
  add constraint users_language_check check (language in ('km', 'en'));

create table if not exists public.notification_job_log (
  job text not null,
  run_key text not null,         -- e.g. '2026-10-23' or '2026-10-23T14'
  ran_at timestamptz not null default now(),
  primary key (job, run_key)
);

grant all on public.notification_job_log to service_role;
