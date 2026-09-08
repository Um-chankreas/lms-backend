-- In-app notification feed (the 🔔 bell). Step 1: real, stored notifications
-- for LOGGED-IN students only, for friend + owner activity around
--   - completing a lesson
--   - completing (submitting) a quiz
--   - a friend beating your quiz score
--
-- "Friends" = students who share a course (same set the activity feed and
-- leaderboard use). No push, no email, no scheduled reminders yet.

create table if not exists public.notifications (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  -- 'lesson_complete' | 'quiz_complete' | 'friend_lesson' | 'friend_quiz' | 'friend_beat_score'
  type text not null,
  title text not null,
  body text not null,
  -- routing / display payload, e.g. { lesson_id, quiz_id, actor_id, score }
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id) where read_at is null;

grant all on public.notifications to service_role;
grant all on public.notifications to anon, authenticated;
