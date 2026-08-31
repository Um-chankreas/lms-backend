-- A lesson can now carry, independently:
--   * a reading  -> lessons.file_url / file_type / *_page / text_content  (unchanged)
--   * a video    -> lessons.video_url / duration_seconds
--   * any number of extra downloadable files -> lesson_attachments
-- See src/routes/lessons.routes.js.

alter table public.lessons
  add column if not exists video_url text,
  add column if not exists duration_seconds integer;

create table if not exists public.lesson_attachments (
  id uuid primary key,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  file_url text not null,            -- storage path inside the course-materials bucket
  title text,
  size_bytes bigint,
  content_type text,
  order_number int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists lesson_attachments_lesson_idx
  on public.lesson_attachments(lesson_id);

grant all on public.lesson_attachments to service_role;
grant all on public.lesson_attachments to anon, authenticated;
