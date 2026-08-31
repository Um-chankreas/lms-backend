-- Live classes: a teacher starts an online session for one of their courses
-- from the web portal; enrolled students see it in the mobile app and join
-- the Agora video channel. See src/routes/liveClass.routes.js.

create table if not exists public.live_classes (
  id uuid primary key,
  course_id uuid not null references public.courses(id),
  teacher_id uuid not null references public.users(id),
  title text not null,
  description text default '',
  channel_name text not null unique,
  status text not null default 'scheduled', -- scheduled | active | completed
  scheduled_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists live_classes_course_id_idx on public.live_classes(course_id);
create index if not exists live_classes_status_idx on public.live_classes(status);

create table if not exists public.live_class_participants (
  id uuid primary key,
  live_class_id uuid not null references public.live_classes(id),
  user_id uuid not null references public.users(id),
  role text not null, -- teacher | student
  joined_at timestamptz not null default now(),
  left_at timestamptz
);

create index if not exists live_class_participants_class_idx on public.live_class_participants(live_class_id);

-- At most one "currently joined" row per user per class, so repeated join
-- calls (reconnects / app relaunch) don't pile up duplicate participants.
create unique index if not exists live_class_participants_one_open_per_user
  on public.live_class_participants(live_class_id, user_id)
  where left_at is null;
