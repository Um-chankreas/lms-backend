-- Per-course payment, managed by an admin from the web portal. A student can
-- only see / join a course's live classes once an admin has marked them paid
-- for that course. Payment lives on the existing course_enrollments row (the
-- admin upserts one if the student has never opened the course).
--
-- The admin itself is just a users row with role = 'admin' (no schema change;
-- create the first one with scripts/create-admin.js).

alter table public.course_enrollments
  add column if not exists paid         boolean not null default false,
  add column if not exists paid_at      timestamp without time zone,
  add column if not exists paid_until   date,
  add column if not exists payment_note text;

create index if not exists course_enrollments_paid_idx
  on public.course_enrollments (student_id, paid);
