-- Poster image for a lesson video. Generated on the client (a frame grabbed
-- from the video) and uploaded like any other file; the storage path is
-- saved here. Shown as the lesson's thumbnail in course listings.
-- See src/routes/lessons.routes.js (POST /:id/video/thumbnail/upload-url).

alter table public.lessons
  add column if not exists thumbnail_url text;
