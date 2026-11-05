-- Device registry, app version settings, per-account tour flag, admin device stats.
--
-- Run in the Supabase SQL editor (dev and prod), AFTER 064_telegram.sql
-- (it adds a column to student_private).
--
-- The app talks only to lms-backend, which uses the service-role key. Every table
-- here has RLS on and NO policies, and every function is executable by
-- service_role only, so students (who never hold a Supabase key) cannot reach any
-- of it. What a role may see is decided in the backend routes.

-- ---------------------------------------------------------------------------
-- 1. device_sessions: one row per (account, install)
-- ---------------------------------------------------------------------------
-- Holds only: phone model, OS version, app version. No advertising id, no IMEI,
-- no IP. `device_id` is a random id the app generates on first launch; it is not
-- tied to the hardware and changes on reinstall.
create table if not exists public.device_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  device_id text not null,
  platform text not null check (platform in ('android', 'ios')),
  model text,
  os_version text,
  app_version text,
  app_build text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, device_id)
);
create index if not exists device_sessions_last_seen_idx on public.device_sessions (last_seen_at);
create index if not exists device_sessions_user_idx on public.device_sessions (user_id);

alter table public.device_sessions enable row level security;
grant all on public.device_sessions to service_role;

-- Upsert called by POST /api/devices/register. Refreshes the version fields and
-- last_seen_at every time, so an old user who updates the app is recorded the
-- first time they open it, with no new login.
create or replace function public.register_device(
  p_user_id uuid,
  p_device_id text,
  p_platform text,
  p_model text,
  p_os_version text,
  p_app_version text,
  p_app_build text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.device_sessions
    (user_id, device_id, platform, model, os_version, app_version, app_build)
  values
    (p_user_id, p_device_id, p_platform, p_model, p_os_version, p_app_version, p_app_build)
  on conflict (user_id, device_id) do update set
    platform = excluded.platform,
    model = excluded.model,
    os_version = excluded.os_version,
    app_version = excluded.app_version,
    app_build = excluded.app_build,
    last_seen_at = now();
$$;

revoke all on function public.register_device(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.register_device(uuid, text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. app_settings: min / latest app version and store links
-- ---------------------------------------------------------------------------
-- Keys read by GET /api/app-version (an empty or missing row falls back to the
-- APP_* environment variables, so nothing breaks if this is not filled in):
--   min_app_version, latest_app_version, store_url_android, store_url_ios
-- Optional: min_build, latest_build (Android versionCode / iOS buildNumber).
create table if not exists public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
grant all on public.app_settings to service_role;

insert into public.app_settings (key, value) values
  ('min_app_version', null),
  ('latest_app_version', null),
  ('store_url_android', 'https://play.google.com/store/apps/details?id=com.romduolscholars.app'),
  ('store_url_ios', null)
on conflict (key) do nothing;

-- To use:
--   update public.app_settings set value = '1.2.0', updated_at = now() where key = 'min_app_version';
--   update public.app_settings set value = '1.2.3', updated_at = now() where key = 'latest_app_version';

-- ---------------------------------------------------------------------------
-- 3. Tour flag, saved per account
-- ---------------------------------------------------------------------------
alter table public.student_private
  add column if not exists tour_completed_at timestamptz;

-- Everyone who already has an account has nothing to be walked through. Run this
-- migration on release day, just before the new app goes out: anyone created
-- before now counts as having seen the tour. Students only; teachers never get
-- the student tour.
insert into public.student_private (user_id, tour_completed_at)
select u.id, now()
from public.users u
where u.role = 'student'
  and u.created_at < now()
on conflict (user_id) do update
  set tour_completed_at = coalesce(public.student_private.tour_completed_at, excluded.tour_completed_at);

-- ---------------------------------------------------------------------------
-- 4. Admin stats. Totals only, never raw rows.
-- ---------------------------------------------------------------------------
-- "Active" = the device was seen in the last 30 days.
-- Models used by fewer than 3 people are folded into one "Other" row so a rare
-- phone can't point at one student.

create or replace function public.device_models_summary()
returns table (platform text, model text, users bigint, active_30d bigint)
language sql
stable
security definer
set search_path = public
as $$
  with per_model as (
    select
      d.platform,
      coalesce(nullif(trim(d.model), ''), 'Unknown') as model,
      count(distinct d.user_id) as users,
      count(distinct d.user_id) filter (where d.last_seen_at >= now() - interval '30 days') as active_30d
    from public.device_sessions d
    group by 1, 2
  )
  select p.platform,
         case when p.users < 3 then 'Other (fewer than 3 users)' else p.model end as model,
         sum(p.users)::bigint as users,
         sum(p.active_30d)::bigint as active_30d
  from per_model p
  group by 1, 2
  order by users desc, model;
$$;

create or replace function public.devices_per_user_summary()
returns table (devices text, users bigint)
language sql
stable
security definer
set search_path = public
as $$
  with per_user as (
    select d.user_id, count(*) as n
    from public.device_sessions d
    where d.last_seen_at >= now() - interval '30 days'
    group by d.user_id
  )
  select b.label as devices,
         count(p.user_id)::bigint as users
  from (values (1, '1'), (2, '2'), (3, '3'), (4, '4+')) as b(n, label)
  left join per_user p
    on (b.n < 4 and p.n = b.n) or (b.n = 4 and p.n >= 4)
  group by b.n, b.label
  order by b.n;
$$;

-- users per app version (active devices, last 30 days) and adoption:
-- of the users who did something in the last 30 days (earned XP), how many have
-- registered a device, i.e. opened the version of the app that reports it.
create or replace function public.app_version_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with versions as (
    select d.platform,
           coalesce(nullif(trim(d.app_version), ''), 'Unknown') as app_version,
           count(distinct d.user_id) as users
    from public.device_sessions d
    where d.last_seen_at >= now() - interval '30 days'
    group by 1, 2
  ),
  active as (
    select distinct x.student_id as user_id
    from public.xp_events x
    where x.created_at >= now() - interval '30 days'
  ),
  adoption as (
    select count(*) as active_users,
           count(*) filter (
             where exists (select 1 from public.device_sessions d where d.user_id = a.user_id)
           ) as with_device
    from active a
  )
  select jsonb_build_object(
    'versions', coalesce(
      (select jsonb_agg(jsonb_build_object('platform', v.platform, 'app_version', v.app_version, 'users', v.users)
                        order by v.platform, v.app_version desc) from versions v),
      '[]'::jsonb),
    'active_users_30d', (select active_users from adoption),
    'active_with_device_30d', (select with_device from adoption),
    'adoption_pct', (select case when active_users = 0 then 0
                                 else round(100.0 * with_device / active_users, 1) end from adoption)
  );
$$;

revoke all on function public.device_models_summary() from public, anon, authenticated;
revoke all on function public.devices_per_user_summary() from public, anon, authenticated;
revoke all on function public.app_version_summary() from public, anon, authenticated;
grant execute on function public.device_models_summary() to service_role;
grant execute on function public.devices_per_user_summary() to service_role;
grant execute on function public.app_version_summary() to service_role;

-- ---------------------------------------------------------------------------
-- 5. Optional, one-time: rough "devices per user" today (no model info)
-- ---------------------------------------------------------------------------
-- Supabase Auth sessions. NOTE: this app signs users in with its own JWT
-- (lms-backend), not Supabase Auth, so auth.sessions is probably empty. If it
-- returns nothing, that is why; use devices_per_user_summary() once users have
-- opened the new app instead.
--
-- select least(n, 4) as devices, count(*) as users
-- from (select user_id, count(*) as n from auth.sessions group by user_id) s
-- group by 1 order by 1;
