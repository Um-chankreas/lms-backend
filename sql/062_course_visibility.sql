-- Lets staff keep a class hidden from students (a test class, or one still
-- being built). Hidden classes stay visible to teachers and admins and can
-- still be opened by direct link; they just stop appearing in the student
-- app's class list. Default true, so every existing class is unchanged.
alter table courses
  add column if not exists is_published boolean not null default true;
