-- Assignment results page: a teacher can close an assignment early, and every
-- manual reminder is logged (who sent it, what it said, how many got it) so the
-- page can show "Reminded 2h ago" and the server can block spam.
--
-- Run in the Supabase SQL editor (dev and prod).

alter table public.assignments
  add column if not exists closed_at timestamptz;

create table if not exists public.assignment_reminders (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  sent_by uuid references public.users(id) on delete set null,
  title text not null,
  body text not null,
  sent integer not null default 0,
  pending integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists assignment_reminders_assignment_idx
  on public.assignment_reminders (assignment_id, created_at desc);
