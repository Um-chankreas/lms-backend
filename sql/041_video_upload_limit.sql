-- Raise the course-materials bucket cap from 50 MB to 1.5 GB so teachers can
-- upload full lesson/unit videos (uploads go browser -> Supabase Storage via a
-- signed URL, so this bucket limit is what returns "Payload too large").
--
-- 1.5 GB = 1.5 * 1024^3 = 1610612736 bytes.
--
-- ALSO REQUIRED (dashboard only, cannot be done in SQL): Storage -> Settings ->
-- "Upload file size limit" must be >= 1.5 GB (needs the Pro plan). The smaller
-- of the global limit and this bucket limit wins.
--
-- Run in the Supabase SQL editor (prod; dev too if you want the same cap).

update storage.buckets
set file_size_limit = 1610612736
where id = 'course-materials';
