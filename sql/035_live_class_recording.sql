-- Recording lifecycle for a live class, via 100ms's composite-recording API.
-- One recording per class: teacher starts it while live (POST .../recording/start),
-- stops it or it's auto-stopped when the class ends, then once 100ms's
-- `beam.recording.success` webhook reports it's ready, the teacher explicitly
-- "saves" it into a course chapter as a regular lesson_attachments video.
-- See src/routes/liveClass.routes.js and src/utils/hmsToken.js.
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.live_classes
  add column if not exists recording_status text,              -- null | recording | processing | ready | failed
  add column if not exists recording_job_id text,               -- 100ms recording job id (POST .../start response.id)
  add column if not exists recording_url text,                  -- presigned url from the webhook; only used to fetch-and-save
  add column if not exists recording_duration_seconds integer,
  add column if not exists recording_started_at timestamptz,
  add column if not exists recording_stopped_at timestamptz,
  add column if not exists recording_saved_lesson_id uuid references public.lessons(id),
  add column if not exists recording_saved_at timestamptz;

-- Makes the webhook's room_id -> live_class lookup unambiguous.
create unique index if not exists live_classes_hms_room_id_idx
  on public.live_classes(hms_room_id) where hms_room_id is not null;
