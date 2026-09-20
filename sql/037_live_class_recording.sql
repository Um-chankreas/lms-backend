-- Links a live class to the lesson (chapter video) its OBS recording was saved as.
-- The recording itself is uploaded by the teacher's browser through the existing
-- lesson video flow (POST /lessons/:id/video/upload-url -> /video); this only
-- records which lesson it became so the class can show "recording saved".
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.live_classes
  add column if not exists recording_lesson_id uuid references public.lessons(id) on delete set null,
  add column if not exists recording_saved_at timestamptz;
