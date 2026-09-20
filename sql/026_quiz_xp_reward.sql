-- Fixed XP reward per quiz. Shown on the mobile quiz header ("+80 XP") and
-- granted flat on the student's first pass — replaces the old score-scaled
-- award (xpForQuizScore) for every quiz, since the column is NOT NULL.
-- Existing quizzes get 80.
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.quizzes
  add column if not exists xp_reward integer not null default 80;
