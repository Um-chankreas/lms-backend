-- Sign in / sign up with Telegram. The app asks for a request, the student taps
-- the bot link and confirms in Telegram, and the app collects the result.
--   ref        public id inside the t.me/<bot>?start=login_<ref> link
--   token_hash SHA-256 of the secret the app holds; only the app can collect the login
create table if not exists public.telegram_login_requests (
  ref text primary key,
  token_hash text not null unique,
  device_label text,
  status text not null default 'pending' check (status in ('pending', 'awaiting', 'approved', 'denied')),
  telegram_user_id bigint,
  telegram_chat_id bigint,
  telegram_username text,
  telegram_first_name text,
  telegram_last_name text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists telegram_login_requests_expires_idx on public.telegram_login_requests (expires_at);

alter table public.telegram_login_requests enable row level security;
grant all on public.telegram_login_requests to service_role;
