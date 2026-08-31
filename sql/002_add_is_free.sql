-- Adds free/paid gating at both the course and lesson level.
-- Default is false (paid) so nothing becomes unexpectedly public —
-- mark specific courses/lessons free explicitly via PUT /api/courses/:id
-- or PUT /api/lessons/:id once the API supports it.

alter table public.courses
  add column if not exists is_free boolean not null default false;

alter table public.lessons
  add column if not exists is_free boolean not null default false;
