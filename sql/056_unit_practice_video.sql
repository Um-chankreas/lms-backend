-- A unit can now carry two optional videos: a lesson video and a practice video
-- (questions & homework). Both are optional — a unit may have either, both, or neither.
--
-- The existing video (video_url / duration_seconds) simply IS the lesson video, so there is
-- nothing to migrate: units that already had a video keep it as their lesson video. This only
-- adds the practice video's columns.
alter table public.lesson_units
  add column if not exists practice_video_url text,
  add column if not exists practice_duration_seconds integer;
