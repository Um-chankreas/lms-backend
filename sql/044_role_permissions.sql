-- Makes the role -> feature defaults (previously a hardcoded ROLE_DEFAULTS
-- object in src/utils/permissions.js) editable from the Roles & Permissions
-- page instead of requiring a code change + deploy. Per-user overrides
-- (feature_permissions, sql/043) still apply on top of whatever this table
-- says for that user's role.
--
-- Seeded with exactly what was previously hardcoded, so nothing changes
-- behaviorally until someone edits the matrix in the UI.
--
-- Run in the Supabase SQL editor (prod; dev too if you want to test there).

create table if not exists public.role_permissions (
  role text not null,
  feature_key text not null,
  allowed boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id),
  primary key (role, feature_key)
);

grant all on public.role_permissions to service_role;

insert into public.role_permissions (role, feature_key, allowed) values
  ('student', 'dashboard', false),
  ('student', 'schedule', false),
  ('student', 'latex_to_text', false),
  ('student', 'trim_video', false),
  ('student', 'compress_video', false),
  ('teacher', 'dashboard', true),
  ('teacher', 'schedule', true),
  ('teacher', 'latex_to_text', false),
  ('teacher', 'trim_video', false),
  ('teacher', 'compress_video', false),
  ('admin', 'dashboard', true),
  ('admin', 'schedule', true),
  ('admin', 'latex_to_text', true),
  ('admin', 'trim_video', true),
  ('admin', 'compress_video', true),
  ('super_admin', 'dashboard', true),
  ('super_admin', 'schedule', true),
  ('super_admin', 'latex_to_text', true),
  ('super_admin', 'trim_video', true),
  ('super_admin', 'compress_video', true)
on conflict (role, feature_key) do nothing;
