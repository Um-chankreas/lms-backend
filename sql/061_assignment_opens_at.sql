-- Scheduled assignments: a published assignment can open for students at a
-- later time. Until `opens_at` passes, students (and the mobile app) do not see
-- it; the teacher sees it as "Scheduled". Students are notified when it opens
-- (opens_notified_at marks that it has been done).
--
-- Run in the Supabase SQL editor (dev and prod).

alter table public.assignments
  add column if not exists opens_at timestamptz,
  add column if not exists opens_notified_at timestamptz;
