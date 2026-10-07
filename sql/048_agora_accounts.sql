-- Switchable Agora projects.
--
-- The free Agora plan gives 10,000 minutes a month per account/project. When
-- one is used up an admin switches to another from the web instead of editing
-- .env and restarting. Credentials live here (the certificate encrypted by the
-- API — it is never sent back to a browser).
--
-- The .env AGORA_APP_ID / AGORA_APP_CERTIFICATE pair stays valid as the
-- built-in account with key 'env'; it is used whenever no row here is active.
--
-- A live class is pinned to ONE account when it starts (live_classes
-- .agora_account = 'env' or an agora_accounts.id). Everyone who joins that
-- class must use the same App ID, so switching the active account only
-- affects classes that start afterwards — a class already running keeps its
-- room.

create table if not exists public.agora_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  app_id text not null unique,
  app_certificate_enc text not null,
  free_minutes integer not null default 10000,
  is_active boolean not null default false,
  created_at timestamp with time zone not null default now()
);

-- At most one active account.
create unique index if not exists agora_accounts_one_active
  on public.agora_accounts (is_active) where is_active;

alter table public.live_classes
  add column if not exists agora_account text;

alter table public.agora_usage_sessions
  add column if not exists agora_account text not null default 'env';
