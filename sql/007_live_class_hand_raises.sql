-- Raise-hand / co-host requests for a live class. A student asks to speak,
-- the teacher approves, and the student then gets a publisher Agora token
-- from POST /api/live-classes/:id/token. Realtime updates are pushed over
-- Socket.IO (src/realtime/liveClassSocket.js) — no polling.

create table if not exists public.live_class_hand_raises (
  live_class_id uuid not null references public.live_classes(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  status        text not null default 'pending', -- pending | approved | denied
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (live_class_id, user_id)
);

create index if not exists live_class_hand_raises_class_status_idx
  on public.live_class_hand_raises(live_class_id, status);

-- The API connects with the service_role key (bypasses RLS), but a raw
-- CREATE TABLE in the SQL editor doesn't inherit the table grants the rest
-- of the schema has — without this the service role gets
-- "permission denied for table live_class_hand_raises".
grant all on public.live_class_hand_raises to service_role;
grant all on public.live_class_hand_raises to anon, authenticated;

