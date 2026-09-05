-- Quizzes can now attach to a unit, not just a chapter.
--
--   quizzes.lesson_id  -> chapter quiz  (unchanged)
--   quizzes.unit_id    -> unit / section practice quiz  (new)
--
-- A unit quiz implies its chapter: when unit_id is set, lesson_id should be
-- the unit's parent chapter and course_id its course.

alter table public.quizzes
  add column if not exists unit_id uuid references public.lesson_units(id) on delete cascade;

create index if not exists quizzes_unit_id_idx on public.quizzes (unit_id);

-- Difficulty tier carried by the practice CSVs (Easy / Medium / Hard).
alter table public.quiz_questions
  add column if not exists difficulty text;

-- The original schema had correct_answer as varchar(1); numeric-entry
-- questions store a number string, and MCQ answers store the full option
-- text, so widen it. (No-op if it is already text.)
alter table public.quiz_questions
  alter column correct_answer type text;
