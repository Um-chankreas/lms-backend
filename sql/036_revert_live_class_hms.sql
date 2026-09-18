-- Reverts 034_live_class_hms_room.sql and 035_live_class_recording.sql: live
-- classes are moving back from 100ms to Agora, and the recording feature
-- (built on 100ms's composite-recording API) is dropped for now.
--
-- channel_name (the Agora channel identifier) was never dropped by either of
-- those migrations, so nothing needs restoring there.
--
-- Run in the Supabase SQL editor (dev + prod).

drop index if exists public.live_classes_hms_room_id_idx;

alter table public.live_classes
  drop column if exists hms_room_id,
  drop column if exists recording_status,
  drop column if exists recording_job_id,
  drop column if exists recording_url,
  drop column if exists recording_duration_seconds,
  drop column if exists recording_started_at,
  drop column if exists recording_stopped_at,
  drop column if exists recording_saved_lesson_id,
  drop column if exists recording_saved_at;
