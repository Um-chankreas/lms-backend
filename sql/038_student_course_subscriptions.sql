-- Per-course live-class subscriptions (replaces the account-level weekly
-- subscription from 014, where users.paid_until unlocked EVERY course).
--
-- One row per (student, course). A student can pay for Math but not History.
-- "Active" is derived, not stored: expiry_date >= today. A stored status column
-- would go stale the moment a subscription lapses (nothing runs on a schedule
-- to flip it). expiry_date NULL means access was revoked.
--
-- courses.live_enabled (the admin's "Course Live Access" switch) still applies
-- on top: live_enabled = false blocks everyone in that course regardless of
-- subscriptions.
--
-- MIGRATION OF EXISTING SUBSCRIBERS: every student whose global subscription is
-- still active gets the same expiry on every course they're enrolled in, so
-- nobody loses access the moment this ships (they could already join every
-- course). Trim per-course from the admin portal afterwards. Expired global
-- subscriptions are not copied (they carry no access).
--
-- users.paid_until / last_paid_at are left in place but are no longer read.
-- (Migration 012's course_enrollments.paid* columns are also unused.)
--
-- Run in the Supabase SQL editor (dev + prod).

create table if not exists public.student_course_subscriptions (
  student_id   uuid not null references public.users(id)   on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  expiry_date  date,
  last_paid_at timestamptz,
  last_updated timestamptz not null default now(),
  primary key (student_id, course_id)
);

-- Only the backend (service_role) touches this table. Unlike the other tables'
-- migrations, anon/authenticated get NO grant and RLS is on with no policies:
-- this table decides who has paid, so the public anon key must not be able to
-- read or edit it through the Data API.
alter table public.student_course_subscriptions enable row level security;
grant all on public.student_course_subscriptions to service_role;

-- "who is subscribed to this course" (notifications) / "is anyone active" (list filter)
create index if not exists student_course_subscriptions_course_idx
  on public.student_course_subscriptions (course_id, expiry_date);
create index if not exists student_course_subscriptions_expiry_idx
  on public.student_course_subscriptions (expiry_date);

insert into public.student_course_subscriptions (student_id, course_id, expiry_date, last_paid_at, last_updated)
select u.id, e.course_id, u.paid_until, u.last_paid_at, now()
from public.users u
join public.course_enrollments e on e.student_id = u.id
where u.role = 'student'
  and u.paid_until is not null
  and u.paid_until >= current_date
on conflict (student_id, course_id) do nothing;
