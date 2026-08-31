-- Daily quiz: each student gets a fixed set of up to 5 random questions per
-- calendar day, drawn from published quizzes in courses they're enrolled in.
-- One row per (student, day) keeps the set stable across repeat visits in
-- the same day and lets us record whether/how they completed it.

create table if not exists public.daily_quiz_attempts (
  id uuid primary key,
  student_id uuid not null references public.users(id) on delete cascade,
  quiz_date date not null default current_date,
  question_ids jsonb not null default '[]'::jsonb,
  answers jsonb,
  correct_count integer,
  total_count integer,
  score integer,
  completed_at timestamp without time zone,
  created_at timestamp without time zone not null default now(),
  unique (student_id, quiz_date)
);
