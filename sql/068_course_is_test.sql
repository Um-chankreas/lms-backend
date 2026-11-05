-- Test classes. They work like any class (My Classes, live, students) but the
-- admin/teacher dashboard leaves them out of its class filter, cards and tables.
alter table public.courses
  add column if not exists is_test boolean not null default false;

-- The class you made for testing. To mark or unmark another one:
--   update public.courses set is_test = true where title = 'Some Class';
update public.courses set is_test = true where title = 'Test Class';
