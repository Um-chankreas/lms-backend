-- Forgotten-password codes. A 6-digit code is sent to the person's connected
-- Telegram and/or email; only a keyed hash of it is stored here, never the code.
create table if not exists public.password_reset_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists password_reset_codes_user_idx on public.password_reset_codes (user_id, created_at desc);

alter table public.password_reset_codes enable row level security;
grant all on public.password_reset_codes to service_role;
