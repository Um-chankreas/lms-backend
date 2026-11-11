-- Blitz: 60-second speed rounds. One row per finished run; the weekly leaderboard
-- and "best score" are derived from here. Run once per Supabase project.
create table if not exists public.blitz_runs (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  score integer not null default 0,
  correct integer not null default 0,
  wrong integer not null default 0,
  best_combo integer not null default 0,
  xp_awarded integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists blitz_runs_student_idx on public.blitz_runs (student_id, created_at desc);
create index if not exists blitz_runs_week_idx on public.blitz_runs (created_at desc, score desc);
