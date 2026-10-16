-- BACII onboarding + tutoring passes.
--
-- A student answers the onboarding flow (Nites goal, track, subjects, chapter,
-- readiness, optional 3-question check, study time, daily commitment) and we
-- keep the result as their starting plan. Free tutoring sessions cost a
-- "tutoring pass"; recordings are unlimited for now. Passes are a ledger:
-- everyone starts with START_PASSES (see routes/bacii.routes.js), and each
-- row here adds or removes from that.

create table if not exists public.bacii_profiles (
  student_id uuid primary key references public.users(id) on delete cascade,
  goal text check (goal in ('A','B','C','D','E')),
  track text check (track in ('Science','Social')),
  subjects text[] not null default '{}',
  subject_key text,          -- e.g. 'math-sci', 'hist' (src/data/baciiContent.json)
  chapter text,
  chapter_bank text,         -- question set key for the check
  ready smallint check (ready between 1 and 5),
  check_level smallint check (check_level between 0 and 4),
  checked boolean not null default false,
  study_time text check (study_time in ('eve','late','wknd','var')),
  commit_minutes smallint,
  plan_saved_at timestamp with time zone,
  unlimited_until timestamp with time zone,   -- invited friend attended
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.bacii_pass_events (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('class_use','practice','recheck','follow')),
  delta integer not null,
  week_key text not null,    -- 'YYYY-Www' (UTC, ISO week) for the weekly earn cap
  created_at timestamp with time zone not null default now()
);

create index if not exists bacii_pass_events_student_idx
  on public.bacii_pass_events (student_id, created_at desc);
