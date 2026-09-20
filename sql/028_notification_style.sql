-- Per-student notification tone. Picks which copy templates the bell feed
-- uses for friend events (see src/utils/notifyEvents.js):
--   'balanced'    — friendly nudges (default)
--   'competitive' — challenge / rivalry framing
-- Set from the mobile Settings screen (PUT /api/auth/profile).
--
-- Run in the Supabase SQL editor (dev + prod).

alter table public.users
  add column if not exists notification_style text not null default 'balanced';

alter table public.users
  drop constraint if exists users_notification_style_check;
alter table public.users
  add constraint users_notification_style_check
  check (notification_style in ('balanced', 'competitive'));
