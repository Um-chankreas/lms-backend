-- Soft-delete for accounts. An admin "deleting" a student sets is_active =
-- false: they can no longer log in and drop out of admin lists by default,
-- but their submissions / XP / history stay intact and it's reversible.

alter table public.users
  add column if not exists is_active boolean not null default true;
