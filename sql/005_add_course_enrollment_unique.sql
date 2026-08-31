-- Lets the API upsert an enrollment row (used to auto-enroll a student the
-- moment they open a free course) instead of a check-then-insert.
alter table public.course_enrollments
  add constraint course_enrollments_unique_student_course unique (course_id, student_id);
