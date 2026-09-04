-- Self-service account deactivation & deletion (required for the mobile app
-- stores). Flow:
--   * deactivate           -> is_active = false, deactivated_at = now().
--                             Reversible; logging back in reactivates it.
--   * request deletion     -> is_active = false, deletion_requested_at = now(),
--                             deletion_scheduled_at = now() + 30 days.
--                             Reversible via /api/auth/account/restore until
--                             the scheduled date.
--   * purge (grace lapsed) -> personal data scrubbed from the users row and
--                             deleted_at = now(). See
--                             scripts/purge-deleted-accounts.js.
--
-- Learning records (submissions, xp_events, completions, enrollments) are
-- kept but are no longer tied to an identifiable person once scrubbed.

alter table public.users
  add column if not exists deactivated_at        timestamptz,
  add column if not exists deletion_requested_at timestamptz,
  add column if not exists deletion_scheduled_at timestamptz,
  add column if not exists deleted_at            timestamptz;

-- Lets the purge job cheaply find accounts whose grace period has elapsed.
create index if not exists users_deletion_scheduled_idx
  on public.users (deletion_scheduled_at)
  where deletion_scheduled_at is not null;
