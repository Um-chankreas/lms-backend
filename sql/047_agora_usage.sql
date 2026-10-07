-- Agora usage metering.
--
-- Agora bills per user, per minute in a channel (the free plan includes
-- 10,000 minutes a month). live_class_participants can't answer "how many
-- minutes did we use?": a reconnect overwrites joined_at, and a participant
-- row only closes on an explicit leave. This table records one row per
-- continuous stay in a channel — opened when a token is issued for someone
-- who isn't already in, closed on leave / class end / the stale sweeper — so
-- the admin usage page can total minutes per day, month and class.
--
-- `kind`: teacher | student | co_host | admin | recorder (the OBS recorder
-- page joins the channel too, and is billed like any other viewer).
-- user_id is null for the recorder.

create table if not exists public.agora_usage_sessions (
  id uuid primary key default gen_random_uuid(),
  live_class_id uuid not null,
  user_id uuid,
  kind text not null,
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone
);

create index if not exists agora_usage_sessions_started_idx
  on public.agora_usage_sessions (started_at);
create index if not exists agora_usage_sessions_open_idx
  on public.agora_usage_sessions (live_class_id) where ended_at is null;
