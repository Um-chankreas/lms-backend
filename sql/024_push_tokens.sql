-- Expo push tokens — one row per device. A notification insert
-- (src/utils/notifications.js) sends an Expo push to the recipient's tokens.
--
-- Run in the Supabase SQL editor (dev + prod).

create table if not exists public.push_tokens (
  token text primary key,                -- "ExponentPushToken[...]"
  user_id uuid not null references public.users(id) on delete cascade,
  platform text,                          -- 'ios' | 'android' | 'web'
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

grant all on public.push_tokens to service_role;
grant all on public.push_tokens to anon, authenticated;

