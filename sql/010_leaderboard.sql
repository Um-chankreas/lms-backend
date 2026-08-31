-- Leaderboard support: a timestamped XP ledger (for weekly ranks), a badge
-- catalog, and awarded achievements.

-- One row per XP award. users.xp stays as the running lifetime total; this
-- table is what lets us sum XP over a time window (e.g. "this week").
create table if not exists public.xp_events (
  id uuid primary key,
  student_id uuid not null references public.users(id) on delete cascade,
  amount integer not null,
  reason text not null,                 -- 'lesson_complete' | 'quiz_pass' | 'daily_quiz' | 'other'
  created_at timestamp without time zone not null default now()
);

create index if not exists xp_events_student_created_idx on public.xp_events (student_id, created_at);
create index if not exists xp_events_created_idx on public.xp_events (created_at);

-- Badge catalog (stable codes the API and client both key off).
create table if not exists public.badges (
  code text primary key,
  label text not null,
  description text
);

insert into public.badges (code, label, description) values
  ('fast_finisher', 'Fast finisher', 'Scored 100% on a quiz'),
  ('streak_master', 'Streak master', 'Kept a 3-day daily quiz streak'),
  ('quiz_grinder',  'Quiz grinder',  'Passed 5 or more quizzes'),
  ('rising_star',   'Rising Star',   'Earned 50+ XP in the last 7 days')
on conflict (code) do nothing;

-- Achievements actually earned by a student. One row per (student, badge).
create table if not exists public.achievements (
  id uuid primary key,
  student_id uuid not null references public.users(id) on delete cascade,
  badge_code text not null references public.badges(code) on delete cascade,
  earned_at timestamp without time zone not null default now(),
  unique (student_id, badge_code)
);

create index if not exists achievements_student_idx on public.achievements (student_id);

-- Tables created via the SQL editor are owned by `postgres` and don't
-- inherit privileges for the API roles, so grant them explicitly. The
-- backend connects as service_role (same as every other table here, e.g.
-- quiz_questions); the anon key has no access. Without this, inserts fail
-- with "permission denied for table ...".
grant all privileges on public.xp_events   to service_role;
grant all privileges on public.badges       to service_role;
grant all privileges on public.achievements to service_role;

-- NOTE: weekly XP is aggregated in the API layer (src/routes/leaderboard.routes.js)
-- by summing xp_events within the current week. If the user base grows large
-- enough that this gets slow, move it into a SQL function / materialized view.
