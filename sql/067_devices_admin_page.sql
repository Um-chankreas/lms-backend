-- Last activity per student, for the admin Devices page ("Last active" column).
-- Run after 066. service_role only, like the other device functions.
create or replace function public.student_last_active()
returns table (student_id uuid, last_active timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select x.student_id, max(x.created_at)::timestamptz
  from public.xp_events x
  group by x.student_id;
$$;

revoke all on function public.student_last_active() from public, anon, authenticated;
grant execute on function public.student_last_active() to service_role;
