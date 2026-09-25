-- Per-user overrides on top of role defaults for the handful of web-portal
-- pages that are otherwise gated purely by role (see src/utils/permissions.js
-- for the feature list and role defaults). One row per (user, feature) that
-- has been explicitly set; no row means "use the role default".
--
-- Deliberately does NOT cover Student Management or Roles & Permissions —
-- those touch account creation/deletion and payments and stay strictly
-- role-gated (admin.routes.js), not something a stray per-user toggle
-- should be able to open up.
--
-- Run in the Supabase SQL editor (prod; dev too if you want to test there).

create table if not exists public.feature_permissions (
  user_id uuid not null references public.users(id) on delete cascade,
  feature_key text not null,
  allowed boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id),
  primary key (user_id, feature_key)
);

grant all on public.feature_permissions to service_role;
