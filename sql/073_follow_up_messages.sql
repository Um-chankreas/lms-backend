-- Telegram follow-up messages: templates, the outgoing log, student replies.
-- Run once per Supabase project, AFTER 064_telegram.sql and 072_follow_up_rebuild.sql.
-- Then seed the templates:  node scripts/seedTemplates.js   (idempotent, never overwrites an edited row)
-- Only the backend (service role) reads or writes these tables; RLS is on and there are no policies, so app users cannot touch them.

-- 1. Message templates (Khmer and English are separate rows). Edited in the admin "Message templates" page.
create table if not exists public.message_templates (
  key text not null,
  lang text not null check (lang in ('km', 'en')),
  audience text not null default 'student' check (audience in ('student', 'parent')),
  case_code text not null check (case_code in ('new', '0', '1', '2', '3', '4', 'praise')),
  body text not null,
  buttons jsonb not null default '[]'::jsonb,          -- [{ label: {km,en}, target?, callback? }]
  extra jsonb not null default '{}'::jsonb,            -- step_reminder steps map, skip_subject zero-attendance variant
  asks_reason boolean not null default false,
  copy_only boolean not null default false,
  version int not null default 1,
  active boolean not null default true,
  edited boolean not null default false,               -- true once an admin saved it: the seed leaves it alone
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (key, lang)
);

-- 2. The 7 reasons (button label + the bot's reply) and the call_me / help replies.
create table if not exists public.message_reasons (
  reason text primary key,
  label_km text,
  label_en text,
  reply_km text not null,
  reply_en text not null,
  reply_links jsonb not null default '[]'::jsonb,
  edited boolean not null default false,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- 3. Every outgoing follow-up message. (Named follow_up_messages because a different `telegram_messages` table, a group-chat log, already exists in this database and is left alone.)
create table if not exists public.follow_up_messages (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  template_key text,
  template_version int,
  case_code text,
  subject_id uuid references public.courses(id) on delete set null,
  lang text check (lang in ('km', 'en')),
  chat_id bigint,
  body_sent text not null,
  buttons jsonb not null default '[]'::jsonb,           -- what was shown (labels + urls / callbacks)
  sent_by uuid references public.users(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'blocked')),
  error text,
  override_reason text,                                 -- set when the teacher sent past a limit warning
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  telegram_message_id bigint,
  replied_at timestamptz,
  chosen_reason text,                                   -- the reason button the student tapped
  created_at timestamptz not null default now()
);
create index if not exists follow_up_messages_student_idx on public.follow_up_messages (student_id, created_at desc);
create index if not exists follow_up_messages_queue_idx on public.follow_up_messages (scheduled_for) where status = 'queued';
create index if not exists follow_up_messages_chat_idx on public.follow_up_messages (chat_id, telegram_message_id);

-- 4. Free-text replies from students.
create table if not exists public.telegram_inbox (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  message_id uuid references public.follow_up_messages(id) on delete set null,   -- the message they answered
  text text not null,
  received_at timestamptz not null default now(),
  read_by uuid references public.users(id) on delete set null,
  read_at timestamptz
);
create index if not exists telegram_inbox_unread_idx on public.telegram_inbox (received_at desc) where read_at is null;
create index if not exists telegram_inbox_student_idx on public.telegram_inbox (student_id, received_at desc);

-- 5. A retried Telegram update is handled once.
create table if not exists public.telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

-- 6. The follow-up log: where a row came from, and which Telegram message it belongs to ('new' = first-week messages).
alter table public.student_followups
  add column if not exists source text not null default 'teacher' check (source in ('teacher', 'student_button')),
  add column if not exists telegram_message_id uuid references public.follow_up_messages(id) on delete set null;
alter table public.student_followups drop constraint if exists student_followups_case_code_check;
alter table public.student_followups add constraint student_followups_case_code_check
  check (case_code is null or case_code in ('new', '0', '1', '2', '3', '4', 'praise'));
alter table public.student_followups drop constraint if exists student_followups_kind_check;
alter table public.student_followups add constraint student_followups_kind_check
  check (kind in ('note', 'message', 'praise', 'done', 'reopen'));

alter table public.message_templates enable row level security;
alter table public.message_reasons enable row level security;
alter table public.follow_up_messages enable row level security;
alter table public.telegram_inbox enable row level security;
alter table public.telegram_updates enable row level security;
grant all on public.message_templates, public.message_reasons, public.follow_up_messages, public.telegram_inbox, public.telegram_updates to service_role;
