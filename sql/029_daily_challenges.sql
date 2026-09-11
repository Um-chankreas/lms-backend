-- Daily Challenge — a personalized, difficulty-tiered daily challenge, distinct
-- from the flat practice set in daily_quiz_attempts (sql/003_add_daily_quiz.sql,
-- kept as-is for its own /api/quizzes/daily surface). One challenge per student
-- per calendar day, five challenge types, unlimited retakes with answers
-- hidden until the first retake, and its own streak + XP bookkeeping.
--
-- Run in the Supabase SQL editor (dev + prod).

create table if not exists public.daily_challenges (
  id uuid primary key,
  student_id uuid not null references public.users(id) on delete cascade,
  challenge_date date not null default current_date,
  -- MULTIPLE_CHOICE | SPEED | PUZZLE | MATCHING | TRUE_FALSE
  type text not null,
  -- EASY | MEDIUM | HARD | EXPERT
  difficulty text not null,
  -- course categories the questions were drawn from, e.g. ["Math","History"]
  subjects jsonb not null default '[]'::jsonb,
  -- [{ id, text, type, options, correctAnswer, explanation, learningResource }]
  -- (MATCHING's correctAnswer is an array of {left,right} pairs)
  questions jsonb not null default '[]'::jsonb,
  xp_base integer not null,
  -- NOT_STARTED | COMPLETED | RETAKEN
  status text not null default 'NOT_STARTED',
  best_score integer,
  retake_count integer not null default 0,
  -- true once the student has retaken it — gates showing correct answers
  revealed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (student_id, challenge_date)
);

create table if not exists public.daily_challenge_attempts (
  id uuid primary key,
  challenge_id uuid not null references public.daily_challenges(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  attempt_number integer not null,
  -- [{ questionId, studentAnswer, isCorrect, timeSpentSeconds }]
  answers jsonb not null default '[]'::jsonb,
  score integer not null,               -- percentage 0-100
  correct_count integer not null,
  total_questions integer not null,
  time_spent_seconds integer,
  xp_earned integer not null default 0,
  created_at timestamptz not null default now(),
  unique (challenge_id, attempt_number)
);

create table if not exists public.daily_challenge_streaks (
  student_id uuid primary key references public.users(id) on delete cascade,
  current_streak integer not null default 0,
  longest_streak integer not null default 0,
  last_completed_date date,
  updated_at timestamptz not null default now()
);

create index if not exists daily_challenges_student_date_idx
  on public.daily_challenges (student_id, challenge_date desc);
create index if not exists daily_challenge_attempts_challenge_idx
  on public.daily_challenge_attempts (challenge_id, attempt_number);

grant all on public.daily_challenges to service_role;
grant all on public.daily_challenges to anon, authenticated;
grant all on public.daily_challenge_attempts to service_role;
grant all on public.daily_challenge_attempts to anon, authenticated;
grant all on public.daily_challenge_streaks to service_role;
grant all on public.daily_challenge_streaks to anon, authenticated;
