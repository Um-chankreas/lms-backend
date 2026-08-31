-- Payment model (team decision): account-level weekly subscription.
-- A student pays $5/week; while paid_until >= today they can join the live
-- classes of EVERY course. The admin can additionally switch live classes
-- off for a specific course via courses.live_enabled.
--
-- This supersedes the per-course columns added in migration 012
-- (course_enrollments.paid / paid_at / paid_until / payment_note) — those are
-- now unused and can be dropped later.

alter table public.users
  add column if not exists paid_until   date,
  add column if not exists last_paid_at timestamp without time zone;

alter table public.courses
  add column if not exists live_enabled boolean not null default true;
