-- Private student details + Telegram reminders.
--
-- Everything here is PRIVATE: students are mostly under 18, so school,
-- province and Telegram identifiers never go on `users` (which feeds the
-- leaderboard and friend lists). The app talks only to lms-backend, which uses
-- the service-role key, so these tables have RLS on and NO policies: nothing
-- but the server can read or write them. What a student or teacher may see is
-- decided in src/routes/telegram.routes.js.
--
-- The BacII track already lives in bacii_profiles.track; it is not repeated here.
--
-- Run in the Supabase SQL editor (dev and prod).

create table if not exists public.student_private (
  user_id uuid primary key references public.users(id) on delete cascade,
  school text,
  province text,
  telegram_chat_id bigint,
  telegram_user_id bigint,
  telegram_username text,               -- null when the Telegram account has none
  telegram_first_name text,
  telegram_linked_at timestamptz,
  telegram_blocked_at timestamptz,      -- set when the bot gets a 403 (student blocked it)
  telegram_reminders boolean not null default true,
  telegram_visibility text not null default 'teachers'
    check (telegram_visibility in ('teachers', 'friends', 'nobody')),
  telegram_xp_awarded boolean not null default false,   -- the one-time +20 XP
  updated_at timestamptz not null default now()
);

-- One Telegram account can be linked to one student at a time.
create unique index if not exists student_private_telegram_user_idx
  on public.student_private (telegram_user_id) where telegram_user_id is not null;
create index if not exists student_private_telegram_chat_idx
  on public.student_private (telegram_chat_id) where telegram_chat_id is not null;

alter table public.student_private enable row level security;
grant all on public.student_private to service_role;

-- Short-lived codes behind the t.me/<bot>?start=<code> link.
create table if not exists public.telegram_link_codes (
  code text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists telegram_link_codes_user_idx on public.telegram_link_codes (user_id);

alter table public.telegram_link_codes enable row level security;
grant all on public.telegram_link_codes to service_role;

-- One reminder per student per live class, even if the job ticks twice.
create table if not exists public.telegram_reminder_log (
  live_class_id uuid not null references public.live_classes(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (live_class_id, user_id)
);

alter table public.telegram_reminder_log enable row level security;
grant all on public.telegram_reminder_log to service_role;
