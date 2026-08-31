-- Add an optional explanation to each quiz question. It is shown to students
-- after they submit / check their answer, so they understand why the correct
-- answer is correct. Never returned before submission.

alter table public.quiz_questions
  add column if not exists explanation text;
