-- Gamification pass: per-subject XP breakdown + the spec's badge set.
--
-- Run in the Supabase SQL editor (dev and prod).

-- ── Per-subject XP ──────────────────────────────────────────────────────
-- Tag each XP event with the course it came from so the profile / home
-- screens can show "History XP vs Math XP". NULL = not tied to a course
-- (daily practice, and any legacy rows).
alter table public.xp_events
  add column if not exists course_id uuid references public.courses(id) on delete set null;

create index if not exists xp_events_student_course_idx
  on public.xp_events (student_id, course_id);

-- ── New badges ─────────────────────────────────────────────────────────
insert into public.badges (code, label, description) values
  ('first_hundred',       'First 100 XP',        'Earn your first 100 XP'),
  ('streak_7',            '7-Day Streak',        'Keep a 7-day daily-practice streak'),
  ('streak_14',           '14-Day Streak',       'Keep a 14-day daily-practice streak'),
  ('streak_30',           '30-Day Streak',       'Keep a 30-day daily-practice streak'),
  ('quiz_master',         'Quiz Master',         'Pass 10 or more quizzes'),
  ('assignment_champion', 'Assignment Champion', 'Turn in 5 assignments on time'),
  ('level_10',            'Rising Scholar',      'Reach level 10')
on conflict (code) do nothing;
