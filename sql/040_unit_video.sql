-- A unit can now carry its own optional video (in addition to a chapter's
-- optional intro video, lessons.video_url) — see UnitEditForm.vue.
alter table public.lesson_units
  add column if not exists video_url text,
  add column if not exists duration_seconds integer;
