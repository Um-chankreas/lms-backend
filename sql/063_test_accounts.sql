-- Marks accounts that belong to testers or the Romduol Scholars team rather
-- than real students. They keep working normally; they are only left out of
-- the dashboard numbers and class progress lists (unless "include test
-- accounts" is asked for), so analytics reflect real students.
alter table users
  add column if not exists is_test boolean not null default false;
