-- Units (a.k.a. sections) inside a chapter.
--
--   course            -> a class (e.g. "History Grade 12")
--   lessons  row      -> a chapter ("ជំពូកទី១ អាណានិគមបារាំង")
--   lesson_units row  -> a unit  ("Unit 1: ការស្វែងរកអាណាព្យាបាល")
--
-- `content` is Markdown — one column for every subject:
--   * history etc. -> plain Markdown prose (## units, **bold**, paragraphs)
--   * maths only    -> the same Markdown, with LaTeX where a formula is
--                      needed ($ inline $, $$ block $$)
-- The client renders it. No PDFs; a chapter can still carry an optional
-- intro video (lessons.video_url). Completion / XP stay at the chapter
-- level (lesson_completions is unchanged).

create table if not exists public.lesson_units (
  id           uuid primary key,
  lesson_id    uuid not null references public.lessons(id) on delete cascade,
  title        text not null,
  content      text,
  order_number integer not null default 0,
  is_free      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists lesson_units_lesson_idx
  on public.lesson_units (lesson_id, order_number);

-- Substring search on title + content (browse by unit). pg_trgm ships with
-- Supabase; if this extension line fails just run it once from the dashboard.
create extension if not exists pg_trgm;
create index if not exists lesson_units_search_idx
  on public.lesson_units using gin ((coalesce(title,'') || ' ' || coalesce(content,'')) gin_trgm_ops);

-- Tables made in the SQL editor don't inherit the API role grants.
grant all on public.lesson_units to service_role;
grant all on public.lesson_units to anon, authenticated;
