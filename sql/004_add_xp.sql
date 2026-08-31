-- Adds a running XP total to each user, awarded for completing lessons,
-- passing quizzes, and the daily quiz. See src/utils/xp.js for where XP
-- actually gets incremented.

alter table public.users
  add column if not exists xp integer not null default 0;

-- Guarantees a lesson can only be completed (and its XP awarded) once per
-- student, even under a race of two near-simultaneous requests.
alter table public.lesson_completions
  add constraint lesson_completions_unique_student_lesson unique (lesson_id, student_id);
