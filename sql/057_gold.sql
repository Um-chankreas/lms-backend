-- Gold: a second reward currency earned alongside XP (quiz passes, chests,
-- streak milestones, test-out passes). Earn-only for now — what gold buys
-- (hints, streak freeze, cosmetics) is still to be decided.
--
-- Also adds the "first topic skipped via test-out" badge.
--
-- Run in the Supabase SQL editor (dev and prod). The backend keeps working
-- if this has not been run — gold is simply not recorded until it is.

alter table public.users
  add column if not exists gold integer not null default 0;

create table if not exists public.gold_transactions (
  id uuid primary key,
  student_id uuid not null references public.users(id) on delete cascade,
  amount integer not null,
  reason text not null,
  course_id uuid references public.courses(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists gold_transactions_student_idx
  on public.gold_transactions (student_id, created_at desc);

insert into public.badges (code, label, description) values
  ('first_skip', 'Test-Out Pro', 'Skip a topic by passing its quiz')
on conflict (code) do nothing;
