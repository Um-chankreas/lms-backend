-- Duolingo-style learning path for a course: GET /api/courses/:id/path
-- renders each chapter as a node plus a "chest" reward node every few
-- chapters. This table just remembers which chests a student has already
-- claimed, so POST .../path/chest/:chestIndex/claim can't be replayed for
-- infinite XP.

create table if not exists public.path_chest_claims (
  student_id  uuid not null references public.users(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  chest_index integer not null,   -- 0-based position of the chest along the path
  claimed_at  timestamptz not null default now(),
  primary key (student_id, course_id, chest_index)
);

grant all on public.path_chest_claims to service_role;
grant all on public.path_chest_claims to anon, authenticated;
